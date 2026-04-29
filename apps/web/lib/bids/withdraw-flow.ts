/**
 * Provider-side withdraw_bid orchestrator.
 *
 *   1. Build withdraw_bid instruction via Codama (closes BidCommit PDA on-chain,
 *      refunds rent to provider)
 *   2. Wallet signs + sends the transaction
 *   3. Wait for confirmation
 *   4. DELETE /api/bids/[on_chain_pda] to drop the off-chain row + decrement
 *      rfps.bid_count
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSendingSigner,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
} from '@solana/kit';
import { instructions } from '@tender/tender-client';

export type WithdrawBidStage =
  | 'building_tx'
  | 'awaiting_signature'
  | 'confirming_tx'
  | 'cleaning_up';

export interface WithdrawBidInput {
  rfpPda: Address;
  bidPda: string;
  sendingSigner: TransactionSendingSigner;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (stage: WithdrawBidStage) => void;
}

export interface WithdrawBidResult {
  txSignature: string;
}

export async function withdrawBid({
  rfpPda,
  bidPda,
  sendingSigner,
  rpc,
  onProgress,
}: WithdrawBidInput): Promise<WithdrawBidResult> {
  onProgress?.('building_tx');
  const ix = await instructions.getWithdrawBidInstructionAsync({
    provider: sendingSigner,
    rfp: rfpPda,
  });

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

  onProgress?.('confirming_tx');
  await waitForSignatureConfirmed({ rpc, signature: txSignature });

  onProgress?.('cleaning_up');
  const res = await fetch(`/api/bids/${bidPda}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `withdraw_bid landed on-chain but DELETE failed: ${
        body.error ?? `HTTP ${res.status}`
      }. tx: ${txSignature}, bid: ${bidPda}`,
    );
  }

  return { txSignature };
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
