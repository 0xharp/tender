/**
 * Provider-side bid submission orchestrator (Day 6 - PER storage).
 *
 *   1. Sign provider derive-key message → derive provider X25519 keypair
 *   2. (L1 only) Sign bid_pda_seed message → 32-byte opaque PDA seed
 *   3. ECIES-encrypt bid plaintext to BOTH buyer + provider envelopes
 *   4. commit_hash = sha256(buyer_envelope || provider_envelope)
 *   5. Find bid PDA from (rfp, bid_pda_seed)
 *   6. Get TEE auth token (cached) → ER RPC client
 *   7. Build all transactions (init+delegate, write_chunks, finalize) using a
 *      `createNoopSigner` for the provider field - wallet signs the bytes later.
 *   8. signTransactions(...all) - single batched wallet popup for the whole flow.
 *   9. Dispatch tx 1 → base RPC with skipPreflight=true; await confirm.
 *  10. Sleep ~3s for the delegation to propagate to the ER.
 *  11. Dispatch chunk + finalize txs → ER RPC with skipPreflight=true; await each.
 *
 * No off-chain row write - bids are read directly from on-chain BidCommit
 * accounts via getProgramAccounts. See lib/solana/chain-reads.ts.
 *
 * skipPreflight bypasses Phantom's tx simulator, which otherwise rejects txs
 * that touch the unknown delegate / permission programs with "Unexpected error".
 *
 * Sig profile:
 *   L0:  derive-provider, TEE-auth (cached after first), batched-tx-sign  →  3 popups
 *   L1:  + bid_pda_seed                                                   →  4 popups
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { findBidPda, instructions, types } from '@tender/tender-client';

import {
  deriveProviderKeypair,
  deriveProviderSeedMessage,
} from '@/lib/crypto/derive-provider-keypair';
import { encryptBid } from '@/lib/crypto/ecies';
import {
  PER_DEVNET_TEE_VALIDATOR,
  derivePerBidAccounts,
  ensureTeeAuthToken,
  ephemeralRpc,
} from '@/lib/sdks/magicblock';

import type { BidFormValues, BidderVisibility, SealedBidPlaintext } from './schema';

export type BidSubmitStage =
  | 'deriving_provider_key'
  | 'deriving_bid_seed'
  | 'funding_ephemeral_wallet'
  | 'encrypting'
  | 'authenticating_er'
  | 'building_txs'
  | 'awaiting_signature'
  | 'submitting_init'
  | 'awaiting_delegation'
  | 'writing_chunks'
  | 'finalizing'
  | 'saving_metadata';

/** Wallet-standard sign-transactions feature (one batched popup for many txs). */
export type SignTransactions = (
  ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;

/** Provider's payout choice. In the new design, this is determined by the
 *  RFP's bidder_visibility - provider doesn't pick it. */
export type PayoutMode =
  /** Public mode - main wallet signs everything, gets paid + reputation. */
  | { kind: 'main' }
  /**
   * Private mode (v2 claim-based) — bidder ephemeral (HD-derived from
   * main wallet via HKDF) signs every bid + post-award tx locally. The
   * main wallet leaves NO on-chain footprint at all: not in any RFP/Bid
   * field, not in any encrypted envelope, not in any tx fee payer.
   *
   * Symmetric with the buyer side: `rfp.buyer = buyer eph` carries no
   * main-wallet hint; same here for `bid.provider = bidder eph`.
   *
   * The provider's main wallet only ever surfaces post-completion when
   * THEY voluntarily run `attest_win` from their dashboard — that ix
   * re-signs the binding message live (no cached signature needed).
   */
  | {
      kind: 'ephemeral';
      ephemeralKeypair: import('@solana/web3.js').Keypair;
    };

export interface SubmitBidInput {
  rfpId: string;
  rfpPda: Address;
  rfpNonce: Uint8Array;
  buyerEncryptionPubkeyHex: string;
  bidderVisibility: BidderVisibility;
  values: BidFormValues;
  providerWallet: Address;
  /** USDC mint we'll request payment in. Devnet mock USDC by default. */
  payoutMint: Address;
  /** Where milestone payments should land if this bid wins. */
  payoutMode: PayoutMode;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (stage: BidSubmitStage) => void;
}

export interface SubmitBidResult {
  bidPda: string;
  initTxSignature: string;
  finalizeTxSignature: string;
  commitHashHex: string;
  bidderVisibility: BidderVisibility;
}

/** Comfortable headroom under the 1232-byte tx data limit. */
const MAX_CHUNK_BYTES = 900;
const ENVELOPE_KIND_BUYER = 0;
const ENVELOPE_KIND_PROVIDER = 1;
const DELEGATION_PROPAGATION_MS = 3_000;

const addressEncoder = getAddressEncoder();
const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();
const b64Encoder = getBase64Encoder();
void b64Encoder;

/* -------------------------------------------------------------------------- */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function chunkBytes(bytes: Uint8Array, max: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += max) {
    out.push(bytes.slice(offset, Math.min(offset + max, bytes.byteLength)));
  }
  return out;
}

function sha256Two(a: Uint8Array, b: Uint8Array): Uint8Array {
  const concat = new Uint8Array(a.byteLength + b.byteLength);
  concat.set(a, 0);
  concat.set(b, a.byteLength);
  return sha256(concat);
}

/* -------------------------------------------------------------------------- */

export async function submitBid({
  // rfpId intentionally NOT destructured - was used by the old supabase POST
  // that got dropped in the on-chain-source-of-truth migration. Kept in the
  // input shape so callers don't have to change; flow itself only needs the
  // on-chain rfpPda for tx building.
  rfpPda,
  rfpNonce,
  buyerEncryptionPubkeyHex,
  bidderVisibility,
  values,
  providerWallet,
  payoutMint,
  payoutMode,
  signMessage,
  signTransactions,
  rpc,
  onProgress,
}: SubmitBidInput): Promise<SubmitBidResult> {
  // PRIVACY MODE: when an ephemeral keypair is provided, EVERYTHING uses it as
  // the bidder identity - pubkey for fee payer / provider Signer / PDA seed,
  // and secret key for local signing of all bid txs + messages. Main wallet is
  // not consulted at all here; the user is expected to have funded the
  // ephemeral wallet with ~0.03 SOL before reaching this point.
  let effectiveProviderWallet = providerWallet;
  let effectiveSignMessage = signMessage;
  let useLocalSigning = false;
  let ephemeralKeypair: import('@solana/web3.js').Keypair | null = null;

  if (payoutMode.kind === 'ephemeral') {
    ephemeralKeypair = payoutMode.ephemeralKeypair;
    effectiveProviderWallet = ephemeralKeypair.publicKey.toBase58() as Address;
    useLocalSigning = true;

    // Local signMessage that uses the ephemeral secret key. No wallet popups.
    // @solana/web3.js Keypair already wraps ed25519; we use noble's ed25519
    // for the detached-signature path because we want a clean Uint8Array out.
    // The .js suffix on the subpath import matches @noble/curves@2.x's exports map.
    // biome-ignore lint/suspicious/noExplicitAny: noble subpath types vary by version
    const ed = (await import('@noble/curves/ed25519.js')) as any;
    const ed25519 = ed.ed25519 ?? ed.default?.ed25519 ?? ed;
    const seed32 = ephemeralKeypair.secretKey.slice(0, 32);
    effectiveSignMessage = async ({ message }) => {
      const sig = ed25519.sign(message, seed32);
      return { signature: new Uint8Array(sig) };
    };

    // Sanity check: does the ephemeral wallet have enough SOL? Bail early
    // with a clear error so the user knows to fund it.
    const balance = await rpc.getBalance(effectiveProviderWallet).send();
    const lamports = Number(balance.value);
    if (lamports < 25_000_000) {
      throw new Error(
        `Your privacy wallet for this RFP has ${(lamports / 1e9).toFixed(4)} SOL - not enough to cover bid storage rent + transaction fees. Use the "Top up ephemeral" button to send more from your main wallet via Cloak's shielded pool, then retry. (Privacy wallet: ${effectiveProviderWallet})`,
      );
    }
  }

  // 1. provider X25519 keypair - derived from whichever signer we're using.
  // In privacy mode this is from the ephemeral keypair (so the provider
  // envelope is decryptable later by anyone holding the ephemeral keypair).
  onProgress?.('deriving_provider_key');
  const providerSeedMsg = deriveProviderSeedMessage();
  const { signature: providerSig } = await effectiveSignMessage({ message: providerSeedMsg });
  const providerKp = deriveProviderKeypair(providerSig);

  // 2. Bid PDA derives from the SIGNER pubkey directly - `["bid", rfp, signer]`.
  // No separate seed message; in private mode the signer is already an ephemeral
  // wallet (deterministic from main-wallet sig), so the PDA is naturally opaque.
  void rfpNonce; // legacy param - no longer needed since seed = signer.pubkey
  void bidderVisibility; // RFP-level metadata, not used for ix construction

  // 3. ECIES encrypt
  onProgress?.('encrypting');
  const baseFields = {
    priceUsdc: values.price_usdc,
    scope: values.scope,
    timelineDays: values.timeline_days,
    milestones: values.milestones.map((m) => ({
      name: m.name,
      description: m.description,
      amountUsdc: m.amount_usdc,
      durationDays: m.duration_days,
      successCriteria: m.success_criteria ?? '',
    })),
    notes: values.notes,
  };

  // v2 claim-based privacy split: build separate plaintexts per recipient.
  // The buyer + provider envelopes don't have to carry the same JSON, since
  // commit_hash binds whatever bytes ended up in each envelope.
  //
  //   - Buyer envelope: NEVER carries the provider's main wallet. The
  //     buyer doesn't need it for award (claim-based v2 sets winner_provider
  //     to the bid signer; the program's public-mode branch fires when
  //     args.winner_provider == bid.provider). Payout address is forced to
  //     `effectiveProviderWallet` — which equals the bidder ephemeral in
  //     private mode — so the only Solana address the buyer sees is the eph.
  //     Every settlement-path ix (accept / auto_release / resolve_dispute /
  //     dispute_default_split / cancel_with_*) sends funds to bid.provider's
  //     ATA, which IS the eph in private mode. Provider sweeps later via the
  //     dashboard's Ephemeral Sweep panel.
  //
  //   - Provider envelope: carries the actual payout preference (their
  //     real off-chain wallet of record), plus `_bidBinding` for the future
  //     attest_win claim. Decrypted only by the provider with their own
  //     ECIES keypair; never readable by the buyer or by the platform.
  const buyerPlaintext: SealedBidPlaintext = {
    ...baseFields,
    payoutPreference: {
      chain: 'solana',
      asset: 'USDC',
      address: String(effectiveProviderWallet),
    },
    // Cosmetic flag so the buyer-side reveal flow can detect "this was a
    // private-bidder bid" without reading the (now-absent) _bidBinding.
    // The buyer already knows their RFP's bidder_visibility setting; this
    // marker just propagates the bit through to per-bid renderers.
    ...(payoutMode.kind === 'ephemeral' ? { _private: true as const } : {}),
  };
  // Provider envelope: in PUBLIC mode this carries the main wallet as
  // payout (which is already public anyway since bid.provider == main).
  // In PRIVATE mode we force the payout to the eph too — symmetric with
  // the buyer envelope, AND avoids a stale main-wallet hint sitting in
  // the encrypted plaintext that the provider could later accidentally
  // surface in a UI screenshot/log dump. The provider's actual
  // off-chain payout preferences (different chain, different wallet)
  // are out of scope for the on-chain plaintext today.
  const providerPlaintext: SealedBidPlaintext = {
    ...baseFields,
    payoutPreference: {
      chain: 'solana',
      asset: 'USDC',
      address: String(effectiveProviderWallet),
    },
  };
  const buyerBytes = new TextEncoder().encode(JSON.stringify(buyerPlaintext));
  const providerBytes = new TextEncoder().encode(JSON.stringify(providerPlaintext));
  const buyerPub = hexToBytes(buyerEncryptionPubkeyHex);
  const sealedForBuyer = encryptBid(buyerBytes, buyerPub);
  const sealedForProvider = encryptBid(providerBytes, providerKp.x25519PublicKey);
  const commitHash = sha256Two(sealedForBuyer.blob, sealedForProvider.blob);

  // 4. Bid PDA - seeds = ["bid", rfp, provider.pubkey]
  const [bidPda] = await findBidPda({
    rfp: rfpPda,
    bidPdaSeed: new Uint8Array(addressEncoder.encode(effectiveProviderWallet)),
  });

  // 5. TEE auth + ER RPC. Caches per-(wallet, rpcUrl); free on subsequent submits.
  // In privacy mode, the ephemeral wallet authenticates (it's the one PER
  // adds to the permission set, so it's the one that can read its own bid).
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(effectiveProviderWallet, async (msg) => {
    const { signature } = await effectiveSignMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  // 6. Build all txs (init+delegate on base, chunks + finalize on ER)
  onProgress?.('building_txs');
  const provider = createNoopSigner(effectiveProviderWallet);

  const payoutDestination = effectiveProviderWallet; // = ephemeral in privacy mode, main otherwise
  const initIx = instructions.getCommitBidInitInstruction({
    provider,
    rfp: rfpPda,
    bid: bidPda,
    commitHash,
    buyerEnvelopeLen: sealedForBuyer.blob.byteLength,
    providerEnvelopeLen: sealedForProvider.blob.byteLength,
    payoutDestination,
    payoutChain: types.payoutChain('Solana', { mint: payoutMint }),
  });
  // Codama's auto-PDA-resolution defaults every `seeds::program` override to
  // OUR program ID, but the delegation_record / delegation_metadata PDAs live
  // under the delegation program, and the permission PDAs live under the
  // permission program. We derive them all explicitly via the magicblock kit
  // helpers and pass them through.
  const perAccounts = await derivePerBidAccounts(bidPda);
  const delegateIx = await instructions.getDelegateBidInstructionAsync({
    provider,
    rfp: rfpPda,
    bid: bidPda,
    validator: PER_DEVNET_TEE_VALIDATOR,
    bufferBid: perAccounts.bufferBid,
    delegationRecordBid: perAccounts.delegationRecordBid,
    delegationMetadataBid: perAccounts.delegationMetadataBid,
    permission: perAccounts.permission,
    bufferPermission: perAccounts.bufferPermission,
    delegationRecordPermission: perAccounts.delegationRecordPermission,
    delegationMetadataPermission: perAccounts.delegationMetadataPermission,
  });

  const buyerChunks = chunkBytes(sealedForBuyer.blob, MAX_CHUNK_BYTES);
  const providerChunks = chunkBytes(sealedForProvider.blob, MAX_CHUNK_BYTES);

  // Pre-fetch base + ER blockhashes. We sign all txs upfront with these
  // blockhashes; both have ~60s validity which comfortably covers our 5–15s
  // dispatch window. If chunk count grows large we may need to re-batch.
  const [{ value: baseBlockhash }, { value: erBlockhash }] = await Promise.all([
    rpc.getLatestBlockhash().send(),
    erRpc.getLatestBlockhash().send(),
  ]);

  // No escrow topup here. The original justification (paying for `withdraw_bid`'s
  // Magic Action) went away when we split withdraw into a 2-tx flow without a
  // Magic Action. `select_bid` still uses one - but the buyer pays for that
  // escrow when they invoke select, not the bidder at submit time. Saves the
  // bidder ~0.011 SOL per submit.
  //
  // Tx 1 - base layer: commit_bid_init + delegate_bid (multi-ix tx).
  const initTxBytes = encodeTx([initIx, delegateIx], effectiveProviderWallet, baseBlockhash);

  // Txs 2..N - ER: write_bid_chunk per chunk (buyer envelope first, then provider).
  const chunkTxBytes: Uint8Array[] = [];
  for (let i = 0; i < buyerChunks.length; i++) {
    const slice = buyerChunks[i];
    if (!slice) continue;
    const ix = instructions.getWriteBidChunkInstruction({
      provider,
      bid: bidPda,
      envelopeKind: ENVELOPE_KIND_BUYER,
      offset: i * MAX_CHUNK_BYTES,
      data: slice,
    });
    chunkTxBytes.push(encodeTx([ix], effectiveProviderWallet, erBlockhash));
  }
  for (let i = 0; i < providerChunks.length; i++) {
    const slice = providerChunks[i];
    if (!slice) continue;
    const ix = instructions.getWriteBidChunkInstruction({
      provider,
      bid: bidPda,
      envelopeKind: ENVELOPE_KIND_PROVIDER,
      offset: i * MAX_CHUNK_BYTES,
      data: slice,
    });
    chunkTxBytes.push(encodeTx([ix], effectiveProviderWallet, erBlockhash));
  }

  // Tx N+1 - ER: finalize_bid.
  const finalizeIx = instructions.getFinalizeBidInstruction({
    provider,
    bid: bidPda,
  });
  const finalizeTxBytes = encodeTx([finalizeIx], effectiveProviderWallet, erBlockhash);

  // 7. Sign all txs. Privacy mode signs locally with the ephemeral keypair
  // (no Phantom popup). Default mode uses the wallet's signTransactions hook.
  onProgress?.('awaiting_signature');
  const allTxs = [initTxBytes, ...chunkTxBytes, finalizeTxBytes];
  let signedBytes: Uint8Array[];
  if (useLocalSigning && ephemeralKeypair) {
    const { VersionedTransaction } = await import('@solana/web3.js');
    signedBytes = allTxs.map((txBytes) => {
      const tx = VersionedTransaction.deserialize(txBytes);
      tx.sign([ephemeralKeypair!]);
      return tx.serialize();
    });
  } else {
    const inputs = allTxs.map((tx) => ({ transaction: tx }));
    const outputs = await signTransactions(...inputs);
    signedBytes = outputs.map((o) => o.signedTransaction);
  }
  const signedInit = signedBytes[0];
  const signedFinalize = signedBytes[signedBytes.length - 1];
  const signedChunks = signedBytes.slice(1, -1);
  if (!signedInit || !signedFinalize) {
    throw new Error('signing returned an unexpected number of outputs');
  }

  // 8. Dispatch tx 1 to base layer with skipPreflight=true (bypasses Phantom's
  // simulator which can't handle the unknown delegate program).
  onProgress?.('submitting_init');
  const initTxSignature = await sendSigned(signedInit, rpc);
  await waitForSignatureConfirmed({ rpc, signature: initTxSignature });

  // 9. Wait for delegation to propagate to the ER.
  onProgress?.('awaiting_delegation');
  await sleep(DELEGATION_PROPAGATION_MS);

  // 10. Dispatch chunks to the ER, sequentially.
  onProgress?.('writing_chunks');
  for (const signed of signedChunks) {
    const sig = await sendSigned(signed, erRpc);
    await waitForSignatureConfirmed({ rpc: erRpc, signature: sig });
  }

  // 11. Dispatch finalize_bid. Once this confirms, the on-chain BidCommit is
  // sealed (status=Committed) and visible to the buyer at reveal-window time.
  // Nothing to write off-chain - bids live entirely on-chain now.
  onProgress?.('finalizing');
  const finalizeTxSignature = await sendSigned(signedFinalize, erRpc);
  await waitForSignatureConfirmed({ rpc: erRpc, signature: finalizeTxSignature });

  return {
    bidPda,
    initTxSignature,
    finalizeTxSignature,
    commitHashHex: bytesToHex(commitHash),
    bidderVisibility,
  };
}

/* -------------------------------------------------------------------------- */
/* Tx helpers                                                                  */
/* -------------------------------------------------------------------------- */

function encodeTx(
  // biome-ignore lint/suspicious/noExplicitAny: ix parameterizations vary
  ixs: any[],
  feePayer: Address,
  blockhash: { blockhash: string; lastValidBlockHeight: bigint },
): Uint8Array {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    // biome-ignore lint/suspicious/noExplicitAny: kit blockhash branding
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const compiled = compileTransaction(message);
  return new Uint8Array(txEncoder.encode(compiled));
}

async function sendSigned(signedTxBytes: Uint8Array, rpc: Rpc<SolanaRpcApi>): Promise<string> {
  const b64 = b64Decoder.decode(signedTxBytes);
  const sig = await rpc
    .sendTransaction(b64 as never, { encoding: 'base64', skipPreflight: true })
    .send();
  return sig as string;
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
      // biome-ignore lint/suspicious/noExplicitAny: kit Signature branding
      .getSignatureStatuses([signature as any])
      .send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        throw new Error(`tx ${signature} failed: ${stringifyTxErr(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${signature} to confirm`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Solana's `status.err` from `getSignatureStatuses` may contain `bigint` values
 * (kit returns u64 fields like slot as bigint). Default `JSON.stringify` throws
 * on those. Use a replacer that coerces bigints to strings so the actual error
 * shape ({ InstructionError: [u8, { Custom: u32 }] } etc.) survives.
 */
function stringifyTxErr(err: unknown): string {
  return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}
