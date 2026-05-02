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
import { USDC_DECIMALS } from '@tender/shared';
import { findRfpPda, instructions, types } from '@tender/tender-client';

import {
  type DerivedRfpKeypair,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import type {
  BidderVisibility,
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
        throw new Error(`tx failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${signature} to confirm`);
}
