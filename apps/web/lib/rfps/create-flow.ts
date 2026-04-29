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
  type TransactionSendingSigner,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
} from '@solana/kit';
import { USDC_DECIMALS } from '@tender/shared';
import { findRfpPda, instructions } from '@tender/tender-client';

import {
  type DerivedRfpKeypair,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import type { RfpCategoryEnum, RfpCreatePayload, RfpFormValues } from '@/lib/rfps/schema';

const CATEGORY_ENUM_INDEX: Record<RfpCategoryEnum, number> = {
  audit: 0,
  design: 1,
  engineering: 2,
  legal: 3,
  marketing: 4,
  market_making: 5,
  other: 6,
};

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

export function evenMilestoneSplit(
  count: number,
): { name: string; description: string; percentage: number }[] {
  const base = Math.floor(100 / count);
  const remainder = 100 - base * count;
  return Array.from({ length: count }, (_, i) => ({
    name: `Milestone ${i + 1}`,
    description: `Milestone ${i + 1} deliverable`,
    percentage: i === count - 1 ? base + remainder : base,
  }));
}

export function isoToUnixSeconds(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

export interface SubmitRfpCreateInput {
  wallet: Address;
  values: RfpFormValues;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  sendingSigner: TransactionSendingSigner;
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

export async function submitRfpCreate({
  wallet,
  values,
  signMessage,
  sendingSigner,
  rpc,
  rpcSubscriptions,
  onProgress,
}: SubmitRfpCreateInput): Promise<SubmitRfpCreateResult> {
  // Step 1 — derive the buyer's RFP encryption keypair
  onProgress?.('deriving_keypair');
  const rfpNonce = generateRfpNonce();
  const seedMessage = deriveSeedMessage(rfpNonce);
  const { signature } = await signMessage({ message: seedMessage });
  const buyerKeypair: DerivedRfpKeypair = deriveRfpKeypair(signature);

  // Step 2 — derive on-chain Rfp PDA
  const [rfpPda] = await findRfpPda({ buyer: wallet, rfpNonce });

  // Step 3 — build the instruction
  onProgress?.('building_tx');
  const now = Date.now();
  const bidOpenAt = BigInt(Math.floor(now / 1000));
  const bidCloseAt = bidOpenAt + BigInt(values.bid_window_hours * 3600);
  const revealCloseAt = bidCloseAt + BigInt(values.reveal_window_hours * 3600);

  const titleHash = sha256(new TextEncoder().encode(values.title));
  const budgetMax = usdcToBaseUnits(values.budget_max_usdc);
  const milestoneTemplate = evenMilestoneSplit(values.milestone_count);

  const ix = instructions.getRfpCreateInstruction({
    buyer: sendingSigner,
    rfp: rfpPda,
    rfpNonce,
    buyerEncryptionPubkey: buyerKeypair.x25519PublicKey,
    titleHash,
    category: CATEGORY_ENUM_INDEX[values.category],
    budgetMax,
    bidOpenAt,
    bidCloseAt,
    revealCloseAt,
    milestoneCount: values.milestone_count,
  });

  // Step 4 — build + sign + send via wallet
  onProgress?.('awaiting_signature');
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sendingSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );

  const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
  const txSignature = getBase58Decoder().decode(signatureBytes);

  // Step 5 — confirm
  onProgress?.('confirming_tx');
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  // Already sent above; explicitly poll for confirmation via the same factory
  // (awaiting via getSignatureStatuses since we sent without confirm above).
  await waitForSignatureConfirmed({ rpc, signature: txSignature });
  void sendAndConfirm; // keep import wired for tree-shaking — used in future ix flows

  // Step 6 — POST metadata
  onProgress?.('saving_metadata');
  const payload: RfpCreatePayload = {
    on_chain_pda: rfpPda,
    rfp_nonce_hex: bytesToHex(rfpNonce),
    buyer_encryption_pubkey_hex: bytesToHex(buyerKeypair.x25519PublicKey),
    title: values.title,
    category: values.category,
    scope_summary: values.scope_summary,
    budget_max_usdc: values.budget_max_usdc,
    bid_open_at: new Date(Number(bidOpenAt) * 1000).toISOString(),
    bid_close_at: new Date(Number(bidCloseAt) * 1000).toISOString(),
    reveal_close_at: new Date(Number(revealCloseAt) * 1000).toISOString(),
    milestone_template: milestoneTemplate,
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
    buyerEncryptionPubkeyHex: payload.buyer_encryption_pubkey_hex,
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
