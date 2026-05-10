import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
/**
 * Orchestrates the buyer-side rfp_create flow:
 *
 *   1. Generate a fresh 8-byte rfp_nonce
 *   2. Sign the derive-key domain message with the wallet → 32-byte X25519 secret
 *   3. Derive the Rfp PDA from (programId, buyer, nonce)
 *   4. Build rfp_create instruction with all args
 *   5. Sign + send the transaction with the wallet
 *   6. Wait for confirmation
 *   7. POST metadata to /api/rfps
 *
 * UI components call `submitRfpCreate` with the resolved hook callbacks +
 * form values. We keep the orchestration pure so it's testable independent
 * of React.
 */
import {
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { TENDER_PROGRAM_ID, USDC_DECIMALS } from '@tender/shared';
import { findRfpPda, instructions, types } from '@tender/tender-client';

import {
  type DerivedRfpKeypair,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import type {
  BidderVisibility,
  BuyerVisibility,
  RfpCategoryEnum,
  RfpCreatePayload,
  RfpFormValues,
} from '@/lib/rfps/schema';

const CATEGORY_ENUM_INDEX: Record<RfpCategoryEnum, number> = {
  audit: 0,
  design: 1,
  engineering: 2,
  legal: 3,
  marketing: 4,
  market_making: 5,
  other: 6,
};

function bidderVisibilityToOnChain(v: BidderVisibility): types.BidderVisibility {
  return v === 'public' ? types.BidderVisibility.Public : types.BidderVisibility.BuyerOnly;
}

function buyerVisibilityToOnChain(v: BuyerVisibility): types.BuyerVisibility {
  return v === 'public' ? types.BuyerVisibility.Public : types.BuyerVisibility.Private;
}

export function generateRfpNonce(): Uint8Array {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return buf;
}

/** Convert a decimal USDC string ("45000.50") to base units (50_000_500_000 lamports). */
export function usdcToBaseUnits(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  return BigInt(whole ?? '0') * BigInt(10) ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || '0');
}

export function isoToUnixSeconds(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

/** Wallet-standard sign-transactions feature (one batched popup for many txs). */
export type SignTransactions = (
  ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;

export interface SubmitRfpCreateInput {
  wallet: Address;
  values: RfpFormValues;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Sign-only path - bypasses Phantom's preflight simulator (rejects unknown CPIs). */
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  onProgress?: (stage: SubmitStage) => void;
}

export type SubmitStage =
  | 'deriving_keypair'
  | 'building_tx'
  | 'awaiting_signature'
  | 'confirming_tx'
  | 'saving_metadata';

export interface SubmitRfpCreateResult {
  rfpPda: string;
  txSignature: string;
  buyerEncryptionPubkeyHex: string;
  rfpNonceHex: string;
}

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();

export async function submitRfpCreate({
  wallet,
  values,
  signMessage,
  signTransactions,
  rpc,
  rpcSubscriptions,
  onProgress,
}: SubmitRfpCreateInput): Promise<SubmitRfpCreateResult> {
  void rpcSubscriptions; // currently unused - kept for future explicit confirm path
  // Step 1 - derive the buyer's RFP encryption keypair
  onProgress?.('deriving_keypair');
  const rfpNonce = generateRfpNonce();
  const seedMessage = deriveSeedMessage(rfpNonce);
  const { signature } = await signMessage({ message: seedMessage });
  const buyerKeypair: DerivedRfpKeypair = deriveRfpKeypair(signature);

  // Step 2 - derive on-chain Rfp PDA
  const [rfpPda] = await findRfpPda({ buyer: wallet, rfpNonce });

  // Step 3 - build the instruction
  onProgress?.('building_tx');
  const now = Date.now();
  const bidOpenAt = BigInt(Math.floor(now / 1000));
  const bidCloseAt = bidOpenAt + BigInt(values.bid_window_hours * 3600);
  const revealCloseAt = bidCloseAt + BigInt(values.reveal_window_hours * 3600);

  const titleHash = sha256(new TextEncoder().encode(values.title));

  // Reserve commitment: SHA256(amount_le_bytes(8) || nonce(32)). All zeros = no reserve.
  let reservePriceCommitment = new Uint8Array(32);
  if (values.reserve_price_usdc && values.reserve_price_usdc.trim() !== '') {
    const reserveAmount = usdcToBaseUnits(values.reserve_price_usdc);
    const reserveNonce = new Uint8Array(32);
    crypto.getRandomValues(reserveNonce);
    const amountLe = new Uint8Array(8);
    const dv = new DataView(amountLe.buffer);
    dv.setBigUint64(0, reserveAmount, true);
    const buf = new Uint8Array(8 + 32);
    buf.set(amountLe, 0);
    buf.set(reserveNonce, 8);
    reservePriceCommitment = sha256(buf);
    // Stash the reveal info locally so the buyer can later call reveal_reserve.
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(
          `tender:reserve:${rfpPda}`,
          JSON.stringify({
            amount: reserveAmount.toString(),
            nonce: bytesToHex(reserveNonce),
          }),
        );
      } catch {
        /* ignore quota errors - buyer can re-create */
      }
    }
  }

  // Sign-only flow - `createNoopSigner` lets the ix builder produce an unsigned
  // tx without requiring a real signer at build time. The wallet signs the bytes
  // via `signTransactions`, then we dispatch with `skipPreflight: true` to
  // bypass Phantom's tx simulator (which mis-rejects our larger args + future
  // unknown CPIs).
  const buyerSigner = createNoopSigner(wallet);
  const ix = instructions.getRfpCreateInstruction({
    buyer: buyerSigner,
    rfp: rfpPda,
    rfpNonce,
    buyerEncryptionPubkey: buyerKeypair.x25519PublicKey,
    titleHash,
    category: CATEGORY_ENUM_INDEX[values.category],
    bidOpenAt,
    bidCloseAt,
    revealCloseAt,
    bidderVisibility: bidderVisibilityToOnChain(values.bidder_visibility),
    buyerVisibility: buyerVisibilityToOnChain(values.buyer_visibility),
    reservePriceCommitment,
    fundingWindowSecs: 0n,
    reviewWindowSecs: 0n,
    disputeCooloffSecs: 0n,
    cancelNoticeSecs: 0n,
    maxIterations: 0,
  });

  // Step 4 - sign-only via wallet, dispatch manually with skipPreflight.
  onProgress?.('awaiting_signature');
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(wallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const compiled = compileTransaction(message);
  const txBytes = new Uint8Array(txEncoder.encode(compiled));
  const [signed] = await signTransactions({ transaction: txBytes });
  if (!signed) throw new Error('signTransactions returned no outputs');

  onProgress?.('confirming_tx');
  const b64 = b64Decoder.decode(signed.signedTransaction);
  const sig = await rpc
    // biome-ignore lint/suspicious/noExplicitAny: kit base64 branding
    .sendTransaction(b64 as any, { encoding: 'base64', skipPreflight: true })
    .send();
  const txSignature = sig as string;
  await waitForSignatureConfirmed({ rpc, signature: txSignature });

  // Step 6 - POST off-chain metadata (only the human-readable fields we don't
  // put on-chain, plus rfp_nonce_hex for PDA seed derivation). Everything
  // else lives on the on-chain Rfp account; clients enrich via
  // lib/solana/chain-reads.ts.
  onProgress?.('saving_metadata');
  const payload: RfpCreatePayload = {
    on_chain_pda: rfpPda,
    rfp_nonce_hex: bytesToHex(rfpNonce),
    title: values.title,
    scope_summary: values.scope_summary,
    tx_signature: txSignature,
  };

  const res = await fetch('/api/rfps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `Saved on-chain but metadata POST failed: ${body.error ?? `HTTP ${res.status}`}. ` +
        `tx: ${txSignature}, rfp: ${rfpPda}`,
    );
  }

  return {
    rfpPda,
    txSignature,
    buyerEncryptionPubkeyHex: bytesToHex(buyerKeypair.x25519PublicKey),
    rfpNonceHex: payload.rfp_nonce_hex,
  };
}

/* -------------------------------------------------------------------------- */
/* submitRfpCreatePrivate — v2 anonymous-buyer create flow.                   */
/*                                                                             */
/* The on-chain `create_rfp` ix is signed by an HD-derived buyer ephemeral    */
/* (not the main wallet) so `rfp.buyer = ephemeral_pubkey` and the buyer's    */
/* main wallet leaves no on-chain footprint. To make that ephemeral usable    */
/* (it needs SOL for tx fee + Rfp PDA rent) we route SOL through Cloak's      */
/* shielded pool first.                                                        */
/*                                                                             */
/* Compared to the public-buyer path (`submitRfpCreate` above):               */
/*  - 2 extra wallet popups (Cloak deposit + viewing-key reg) but ~75s of     */
/*    overall latency. Acceptable for private mode.                            */
/*  - The main wallet's only on-chain trail is the Cloak deposit. The         */
/*    deposit/withdraw cryptographic link is broken inside the shielded       */
/*    pool by the UTXO + ZK-proof model — same property as the bidder side.  */
/*  - Does NOT call /api/rfps to save metadata — keeping the off-chain        */
/*    metadata row keyed on a main-wallet-correlated SIWS session would       */
/*    leak the ephemeral→main link to our supabase. v1 stores nothing;        */
/*    private RFP discovery happens via HD enumeration (lib/keychain).        */
/* -------------------------------------------------------------------------- */

export interface SubmitRfpCreatePrivateInput {
  /** Buyer's main wallet — pays Cloak deposit fees. Never appears as
   *  `rfp.buyer` on-chain. */
  wallet: Address;
  values: RfpFormValues;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  signTransactions: SignTransactions;
  /** Shared HD keychain (KeychainProvider). Reuses the cached master
   *  seed so we don't pop a second master-sign popup if the user has
   *  already unlocked it from another surface this session. */
  keychain: import('@/lib/wallet').KeychainHandle;
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  onProgress?: (stage: PrivateCreateStage) => void;
}

export type PrivateCreateStage =
  | 'unlocking_keychain'
  | 'allocating_slot'
  | 'cloak_funding_ephemeral'
  | 'building_tx'
  | 'signing_locally'
  | 'confirming_tx'
  | 'saving_metadata'
  | 'done';

export interface SubmitRfpCreatePrivateResult {
  rfpPda: string;
  txSignature: string;
  buyerEncryptionPubkeyHex: string;
  rfpNonceHex: string;
  /** Index in the buyer keychain that owns this RFP. Stored in memory so
   *  the user doesn't re-scan immediately after; persistence across
   *  sessions happens via on-chain enumeration. */
  buyerEphemeralIndex: number;
  /** The ephemeral pubkey acting as `rfp.buyer` on-chain. */
  buyerEphemeralPubkey: string;
}

/** SOL the buyer ephemeral receives from Cloak. Covers tx fee + Rfp PDA
 *  rent (~0.0035 SOL for ~430-byte Rfp account) + comfortable headroom
 *  for any subsequent buyer-action ixs that bill rent (init_if_needed
 *  buyer_reputation, milestone PDAs at fund time, etc — though most of
 *  those are paid by funder/payer in v2). 0.06 SOL gives plenty of
 *  margin without parking too much in a stranded ephemeral. */
const PRIVATE_CREATE_SOL_DEPOSIT = 60_000_000n;

export async function submitRfpCreatePrivate({
  wallet,
  values,
  signMessage,
  signTransactions,
  keychain,
  rpc,
  rpcSubscriptions,
  onProgress,
}: SubmitRfpCreatePrivateInput): Promise<SubmitRfpCreatePrivateResult> {
  void rpcSubscriptions;

  // Lazy-load enumerate + Cloak + walletLib + web3 — only the private-
  // create path needs them. The keychain primitive is already available
  // via the passed-in handle.
  const [enumerate, cloak, walletLib, web3] = await Promise.all([
    import('@/lib/keychain/enumerate'),
    import('@/lib/sdks/cloak'),
    import('@/lib/wallet'),
    import('@solana/web3.js'),
  ]);

  // Step 1 — get master seed via shared keychain. If the user already
  // unlocked it earlier in the session (e.g. via DiscoverPrivateRfps),
  // this is silent — no extra wallet popup. Otherwise it pops once.
  onProgress?.('unlocking_keychain');
  const masterSeed = await keychain.getMasterSeed();

  // Step 2 — find the next free buyer-ephemeral index. Reuses gaps left
  // by failed creates so we don't grow indices unboundedly.
  onProgress?.('allocating_slot');
  const ephemeralIndex = await enumerate.nextBuyerIndex(masterSeed);
  const ephemeralBuyer = await keychain.buyerEphemeral(ephemeralIndex);

  // Step 3 — fund the ephemeral with SOL via Cloak's shielded pool.
  // Existing fundEphemeralWallet (SOL path) handles this without an
  // ALT since SOL transfers fit in legacy txs. ~75s end-to-end.
  onProgress?.('cloak_funding_ephemeral');
  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new web3.Connection(rpcUrl, 'confirmed');
  const cloakSignTx = await walletLib.buildCloakSignTransactionAdapter(signTransactions);
  await cloak.fundEphemeralWallet({
    walletPublicKey: new web3.PublicKey(wallet),
    signTransaction: cloakSignTx,
    signMessage: async (msg: Uint8Array) => (await signMessage({ message: msg })).signature,
    ephemeralPubkey: ephemeralBuyer.publicKey,
    depositLamports: PRIVATE_CREATE_SOL_DEPOSIT,
    connection,
  });

  // Step 4 — derive the encryption keypair the same way the public flow
  // does, but rooted on the ephemeral nonce. We treat the form values'
  // rfp_nonce slot specially: it gets generated fresh client-side and
  // is the same nonce that seeds both the encryption keypair AND the
  // Rfp PDA derivation. Off-chain metadata storage skipped (see header).
  onProgress?.('building_tx');
  const rfpNonce = generateRfpNonce();
  const seedMessage = deriveSeedMessage(rfpNonce);
  // For the buyer encryption key, sign with the EPHEMERAL — keeps the
  // x25519 key derivation strictly under the ephemeral's keychain, so
  // recovering it later only requires knowing the ephemeral's secret
  // (which is itself recoverable from the master seed). No main-wallet
  // signature ever touches the encryption pubkey written on-chain.
  const ephemeralSigOverSeed = web3.Ed25519Program; // satisfy linter
  void ephemeralSigOverSeed;
  const noble = await import('@noble/curves/ed25519.js');
  const ephemeralSig = noble.ed25519.sign(seedMessage, ephemeralBuyer.secretKey.slice(0, 32));
  const buyerKeypair: DerivedRfpKeypair = deriveRfpKeypair(ephemeralSig);

  // Step 5 — derive the Rfp PDA. Buyer is the ephemeral pubkey, so the
  // PDA is unique to (ephemeral, nonce) and unlinkable to main wallet.
  const ephemeralAddress = ephemeralBuyer.publicKey.toBase58() as Address;
  const [rfpPda] = await findRfpPda({ buyer: ephemeralAddress, rfpNonce });

  // Step 6 — build the rfp_create ix. ephemeral is the buyer signer.
  const now = Date.now();
  const bidOpenAt = BigInt(Math.floor(now / 1000));
  const bidCloseAt = bidOpenAt + BigInt(values.bid_window_hours * 3600);
  const revealCloseAt = bidCloseAt + BigInt(values.reveal_window_hours * 3600);
  const titleHash = sha256(new TextEncoder().encode(values.title));

  // Reserve commitment computed identically to the public path.
  let reservePriceCommitment = new Uint8Array(32);
  if (values.reserve_price_usdc && values.reserve_price_usdc.trim() !== '') {
    const reserveAmount = usdcToBaseUnits(values.reserve_price_usdc);
    const reserveNonce = new Uint8Array(32);
    crypto.getRandomValues(reserveNonce);
    const amountLe = new Uint8Array(8);
    new DataView(amountLe.buffer).setBigUint64(0, reserveAmount, true);
    const buf = new Uint8Array(8 + 32);
    buf.set(amountLe, 0);
    buf.set(reserveNonce, 8);
    reservePriceCommitment = sha256(buf);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(
          `tender:reserve:${rfpPda}`,
          JSON.stringify({
            amount: reserveAmount.toString(),
            nonce: bytesToHex(reserveNonce),
          }),
        );
      } catch {
        /* ignore quota errors */
      }
    }
  }

  const ephemeralSigner = createNoopSigner(ephemeralAddress);
  const ix = instructions.getRfpCreateInstruction({
    buyer: ephemeralSigner,
    rfp: rfpPda,
    rfpNonce,
    buyerEncryptionPubkey: buyerKeypair.x25519PublicKey,
    titleHash,
    category: CATEGORY_ENUM_INDEX[values.category],
    bidOpenAt,
    bidCloseAt,
    revealCloseAt,
    bidderVisibility: bidderVisibilityToOnChain(values.bidder_visibility),
    buyerVisibility: buyerVisibilityToOnChain(values.buyer_visibility),
    reservePriceCommitment,
    fundingWindowSecs: 0n,
    reviewWindowSecs: 0n,
    disputeCooloffSecs: 0n,
    cancelNoticeSecs: 0n,
    maxIterations: 0,
  });

  // Step 7 — sign locally with the ephemeral keypair. No wallet popup;
  // the ephemeral keypair is in tab memory courtesy of the keychain.
  onProgress?.('signing_locally');
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(ephemeralAddress, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const compiled = compileTransaction(message);
  const txBytes = new Uint8Array(txEncoder.encode(compiled));

  // Use VersionedTransaction.sign with the ephemeral keypair — the kit
  // signing primitives expect a TransactionSigner abstraction, but
  // here we have a raw web3 Keypair and a need to sign without any
  // wallet adapter intermediary. web3 directly suffices.
  const versionedTx = web3.VersionedTransaction.deserialize(txBytes);
  versionedTx.sign([ephemeralBuyer]);
  const signedBytes = versionedTx.serialize();

  // Step 8 — submit + confirm. Same dispatch path as the public flow.
  onProgress?.('confirming_tx');
  const b64 = b64Decoder.decode(signedBytes);
  const sig = await rpc
    // biome-ignore lint/suspicious/noExplicitAny: kit base64 branding
    .sendTransaction(b64 as any, { encoding: 'base64', skipPreflight: true })
    .send();
  const txSignature = sig as string;
  await waitForSignatureConfirmed({ rpc, signature: txSignature });

  // v2: cache the HD buyer index per (rfp, mainWallet) so subsequent
  // surfaces — marketplace "mine" badge, RFP detail page ownership
  // check, BuyerActionPanel detection, etc — can resolve instantly
  // without re-running enumerate. Mirror of the bidder-side cache.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(`tender:buyer-index:${rfpPda}:${wallet}`, String(ephemeralIndex));
    } catch {
      /* quota / storage disabled — non-fatal, enumerate still works */
    }
  }

  // Step 9 — POST the off-chain metadata (title + scope) to /api/rfps
  // so the marketplace can render a human-readable title for this RFP.
  // Auth path: ephemeral self-signs a canonical pin message, server
  // verifies the signature against rfp.buyer on chain. NO SIWS session
  // is consulted, so supabase audit logs do NOT correlate the buyer's
  // main wallet to this rfp_pda — only the ephemeral pubkey appears.
  onProgress?.('saving_metadata');
  const titleHashHex = bytesToHex(titleHash);
  const issuedAt = new Date().toISOString();
  const pinMessage = [
    'tender-metadata-pin-v1',
    `program=${TENDER_PROGRAM_ID}`,
    `rfp=${rfpPda}`,
    `title_hash=${titleHashHex}`,
    `issued_at=${issuedAt}`,
  ].join('\n');
  // Reuse the noble module that's already in scope from the earlier
  // x25519-seed signing step. ed25519 wants the 32-byte seed (Solana
  // keypair secret keys are [seed(32) || pubkey(32)]).
  const pinSig = noble.ed25519.sign(
    new TextEncoder().encode(pinMessage),
    ephemeralBuyer.secretKey.slice(0, 32),
  );
  const pinSigB64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(pinSig).toString('base64')
      : btoa(String.fromCharCode(...pinSig));

  const metaPayload: RfpCreatePayload = {
    on_chain_pda: rfpPda,
    rfp_nonce_hex: bytesToHex(rfpNonce),
    title: values.title,
    scope_summary: values.scope_summary,
    tx_signature: txSignature,
    ephemeral_auth: {
      message: pinMessage,
      signature: pinSigB64,
    },
  };
  const metaRes = await fetch('/api/rfps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metaPayload),
  });
  if (!metaRes.ok) {
    const errBody = await metaRes.json().catch(() => ({}));
    throw new Error(
      `RFP saved on-chain but metadata pin failed: ${errBody.error ?? `HTTP ${metaRes.status}`}. ` +
        `tx: ${txSignature}, rfp: ${rfpPda}`,
    );
  }

  onProgress?.('done');
  return {
    rfpPda,
    txSignature,
    buyerEncryptionPubkeyHex: bytesToHex(buyerKeypair.x25519PublicKey),
    rfpNonceHex: bytesToHex(rfpNonce),
    buyerEphemeralIndex: ephemeralIndex,
    buyerEphemeralPubkey: ephemeralAddress,
  };
}

async function waitForSignatureConfirmed({
  rpc,
  signature,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
}: {
  rpc: Rpc<SolanaRpcApi>;
  signature: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc
      // biome-ignore lint/suspicious/noExplicitAny: kit signature type expects Signature branded string
      .getSignatureStatuses([signature as any])
      .send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        // BigInt-safe replacer — kit's `status.err` payload nests u64
        // fields (slot, CU counts) as bigints; default JSON.stringify
        // throws "Do not know how to serialize a BigInt" on those,
        // masking the real program error code in the user-facing toast.
        throw new Error(
          `tx failed: ${JSON.stringify(status.err, (_k, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          )}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${signature} to confirm`);
}
