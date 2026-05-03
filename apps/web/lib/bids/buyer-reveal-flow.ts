/**
 * Buyer-side bid decryption orchestrator.
 *
 * Used during the `Reveal` phase by the buyer to decrypt every bid on an RFP
 * so they can pick a winner. Mirrors the provider-side reveal pattern in
 * `YourBidPanel`, but decrypts the BUYER envelope (encrypted to the buyer's
 * RFP-specific X25519 pubkey) instead of the provider envelope.
 *
 * Flow (zero-popup happy path after first call in a session):
 *   1. Derive buyer's X25519 keypair from a wallet sig over
 *      `deriveSeedMessage(rfpNonce)` (1 popup, cached per session by the
 *      caller).
 *   2. TEE auth token for buyer wallet (1 popup, cached per (wallet,rpcUrl)
 *      by `ensureTeeAuthToken`).
 *   3. For each bid: try fetch the BidCommit bytes from PER. Bids that return
 *      null are missing the buyer in their PER permission set - call
 *      `open_reveal_window` for those (batched in one signTransactions popup),
 *      then refetch.
 *   4. Decrypt every buyer envelope with the X25519 private key. Parse against
 *      `sealedBidPlaintextSchema` for safety.
 *   5. For private-mode bids, surface `_bidBinding.{mainWallet,
 *      signatureBase64}` so the buyer's award form can populate the binding
 *      args required by `select_bid`'s Ed25519SigVerify check.
 *
 * Errors per bid are returned alongside successes - one failed bid shouldn't
 * block decrypting the rest.
 */
import { type Address, type Rpc, type SolanaRpcApi, createNoopSigner } from '@solana/kit';
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { accounts, instructions } from '@tender/tender-client';

import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import {
  type DerivedRfpKeypair,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import { decryptBid } from '@/lib/crypto/ecies';
import {
  derivePerBidAccounts,
  ensureTeeAuthToken,
  ephemeralRpc,
  fetchDelegatedAccountBytes,
} from '@/lib/sdks/magicblock';

export type BuyerRevealStage =
  | 'deriving_buyer_key'
  | 'authenticating_er'
  | 'fetching_bids'
  | 'opening_reveal_window'
  | 'decrypting'
  | 'done';

/** A single decrypted bid view. `error` is set instead of `plaintext` when
 *  decryption fails for that bid (e.g., bytes still inaccessible after
 *  open_reveal_window, or the envelope is malformed). */
export interface DecryptedBid {
  bidPda: string;
  /** The on-chain bid signer. Public mode: provider's main wallet. Private
   *  mode: ephemeral wallet (deterministic from main wallet sig). */
  bidSignerWallet: string;
  isPrivate: boolean;
  plaintext?: SealedBidPlaintext;
  /** Private-mode only: the provider's main wallet, decrypted from
   *  `_bidBinding.mainWallet`. Same as `bidSignerWallet` for public bids. */
  mainWallet?: string;
  /** Private-mode only: base64 ed25519 signature over the binding message,
   *  required by `select_bid`'s Ed25519SigVerify check. */
  bindingSignatureBase64?: string;
  error?: string;
}

export interface BuyerRevealInput {
  buyerWallet: Address;
  rfpPda: Address;
  rfpNonceHex: string;
  bidPdas: Address[];
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  signTransactions: (
    ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
  ) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
  /** Cached buyer X25519 keypair from a previous call. Pass to skip the
   *  derive popup on subsequent reveals in the same session. */
  cachedBuyerKp?: DerivedRfpKeypair;
  onProgress?: (s: BuyerRevealStage, detail?: string) => void;
}

export interface BuyerRevealResult {
  bids: DecryptedBid[];
  /** Returned so the caller can cache it across re-reveals in this session. */
  buyerKp: DerivedRfpKeypair;
  /** open_reveal_window tx sigs, if any were submitted. */
  openRevealTxSignatures: string[];
}

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function revealAllBidsForBuyer(input: BuyerRevealInput): Promise<BuyerRevealResult> {
  // rfpPda intentionally NOT destructured - we have rfpNonceHex (drives the
  // X25519 derivation) + bidPdas (drives the per-bid open_reveal_window
  // calls). The on-chain RFP account itself isn't read in this flow; PDA
  // verification happens implicitly via the ix accounts list. Keeping rfpPda
  // in the input shape for future symmetry with other flows that DO need it.
  const {
    buyerWallet,
    rfpNonceHex,
    bidPdas,
    signMessage,
    signTransactions,
    cachedBuyerKp,
    onProgress,
  } = input;

  // 1. Buyer X25519 keypair (cached or fresh).
  let buyerKp = cachedBuyerKp;
  if (!buyerKp) {
    onProgress?.('deriving_buyer_key');
    const seedMsg = deriveSeedMessage(hexToBytes(rfpNonceHex));
    const { signature } = await signMessage({ message: seedMsg });
    buyerKp = deriveRfpKeypair(signature);
  }

  // 2. TEE auth + ER RPC.
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(buyerWallet, async (msg) => {
    const { signature } = await signMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  // 3. First-pass fetch - bids the buyer already has read access to come back
  //    immediately. Bids that need open_reveal_window come back as null.
  onProgress?.('fetching_bids');
  const firstPass = await Promise.all(
    bidPdas.map(async (pda) => ({
      pda,
      bytes: await fetchDelegatedAccountBytes(pda, erRpc).catch(() => null),
    })),
  );

  const needsOpen = firstPass.filter((r) => r.bytes == null).map((r) => r.pda);
  const openRevealSigs: string[] = [];

  // 4. open_reveal_window for the bids that returned null. Batched signing -
  //    one popup for all, dispatched to ER in parallel.
  if (needsOpen.length > 0) {
    onProgress?.('opening_reveal_window', `${needsOpen.length} bid(s)`);
    const buyerSigner = createNoopSigner(buyerWallet);
    const { value: erBlockhash } = await erRpc.getLatestBlockhash().send();
    const txBytesList: Uint8Array[] = [];
    for (const pda of needsOpen) {
      const perAccounts = await derivePerBidAccounts(pda);
      const ix = await instructions.getOpenRevealWindowInstructionAsync({
        payer: buyerSigner,
        bid: pda,
        permission: perAccounts.permission,
      });
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(buyerWallet, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(erBlockhash, m),
        (m) => appendTransactionMessageInstruction(ix, m),
      );
      const compiled = compileTransaction(message);
      txBytesList.push(new Uint8Array(txEncoder.encode(compiled)));
    }
    const signed = await signTransactions(...txBytesList.map((tx) => ({ transaction: tx })));

    // Submit in parallel.
    const sigs = await Promise.all(
      signed.map(async (s) => {
        const b64 = b64Decoder.decode(s.signedTransaction);
        const sig = (await erRpc
          // biome-ignore lint/suspicious/noExplicitAny: kit base64 branding requires this cast at sendTransaction call sites
          .sendTransaction(b64 as any, { encoding: 'base64', skipPreflight: true })
          .send()) as string;
        return sig;
      }),
    );
    openRevealSigs.push(...sigs);

    // Wait for at least one confirmation each. Skip detailed polling - we'll
    // refetch and rely on the result to determine success per bid.
    await Promise.all(sigs.map((sig) => waitConfirmedShort(erRpc, sig)));

    // Refetch the previously-null bids.
    const refetched = await Promise.all(
      needsOpen.map(async (pda) => ({
        pda,
        bytes: await fetchDelegatedAccountBytes(pda, erRpc).catch(() => null),
      })),
    );
    for (const r of refetched) {
      const i = firstPass.findIndex((f) => f.pda === r.pda);
      if (i >= 0) firstPass[i] = r;
    }
  }

  // 5. Decode + decrypt each bid.
  onProgress?.('decrypting');
  const out: DecryptedBid[] = firstPass.map((r) => {
    if (!r.bytes) {
      return {
        bidPda: r.pda,
        bidSignerWallet: '',
        isPrivate: false,
        error:
          'PER read access still denied after open_reveal_window. The bid may have been withdrawn or selected.',
      };
    }
    try {
      const decoded = accounts.getBidCommitDecoder().decode(r.bytes);
      const buyerEnvelope = decoded.buyerEnvelope as Uint8Array;
      const json = new TextDecoder().decode(decryptBid(buyerEnvelope, buyerKp?.x25519PrivateKey));
      const parsedRaw = JSON.parse(json);
      const parsed = sealedBidPlaintextSchema.safeParse(parsedRaw);
      if (!parsed.success) {
        return {
          bidPda: r.pda,
          bidSignerWallet: String(decoded.provider),
          isPrivate: false,
          error: 'Plaintext failed schema validation.',
        };
      }
      // Detect private mode + extract binding fields. The submit flow embeds
      // _bidBinding inside the encrypted plaintext only for private RFPs.
      const binding = (
        parsedRaw as { _bidBinding?: { mainWallet?: string; signatureBase64?: string } }
      )._bidBinding;
      const isPrivate = !!binding;
      return {
        bidPda: r.pda,
        bidSignerWallet: String(decoded.provider),
        isPrivate,
        plaintext: parsed.data,
        mainWallet: isPrivate ? binding?.mainWallet : String(decoded.provider),
        bindingSignatureBase64: isPrivate ? binding?.signatureBase64 : undefined,
      };
    } catch (e) {
      return {
        bidPda: r.pda,
        bidSignerWallet: '',
        isPrivate: false,
        error: (e as Error).message ?? 'decode/decrypt failed',
      };
    }
  });

  onProgress?.('done');
  return { bids: out, buyerKp, openRevealTxSignatures: openRevealSigs };
}

async function waitConfirmedShort(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { value } = await rpc
      // biome-ignore lint/suspicious/noExplicitAny: kit branding
      .getSignatureStatuses([signature as any])
      .send();
    const s = value[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 800));
  }
  // Don't throw - we'll retry the fetch and surface a per-bid error if it
  // genuinely failed.
}
