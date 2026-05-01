/**
 * Permissionless `open_reveal_window` orchestrator (Day 6).
 *
 * Anyone can call this once `clock >= bid.bid_close_at`. The handler updates
 * the bid's permission account on the ER to add the buyer as a `READ_ONLY`
 * member, unlocking buyer-side decryption of the ECIES envelopes that have
 * been gated behind PER's TEE since `commit_bid_init`.
 *
 *   L0 (Public): anyone can call — caller looks up `bid.provider_identity::Plain`
 *                and passes the pubkey. UI typically auto-fires for all bids on
 *                the RFP detail page after the window closes.
 *   L1 (BuyerOnly): only the provider knows their own pubkey, so the provider
 *                   is the natural caller. They invoke this once they want the
 *                   buyer to be able to read their bid.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { instructions } from '@tender/tender-client';

import { derivePerBidAccounts, ensureTeeAuthToken, ephemeralRpc } from '@/lib/sdks/magicblock';

export type OpenRevealStage = 'authenticating_er' | 'submitting' | 'confirming';

export interface OpenRevealWindowInput {
  bidPda: Address;
  /** Provider's wallet pubkey — verified against `bid.provider_identity` on-chain. */
  providerWallet: Address;
  /** Caller — anyone (L0) or the provider themselves (L1). */
  callerWallet: Address;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  sendingSigner: TransactionSigner;
  onProgress?: (stage: OpenRevealStage) => void;
}

export interface OpenRevealWindowResult {
  txSignature: string;
}

export async function openRevealWindow({
  bidPda,
  providerWallet,
  callerWallet,
  signMessage,
  sendingSigner,
  onProgress,
}: OpenRevealWindowInput): Promise<OpenRevealWindowResult> {
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(callerWallet, async (msg) => {
    const { signature } = await signMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  onProgress?.('submitting');
  const perAccounts = await derivePerBidAccounts(bidPda);
  const ix = await instructions.getOpenRevealWindowInstructionAsync({
    payer: sendingSigner,
    bid: bidPda,
    providerWallet,
    permission: perAccounts.permission,
  });

  const { value: blockhash } = await erRpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(sendingSigner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const txSignature = (await erRpc
    .sendTransaction(wire, { encoding: 'base64', skipPreflight: true })
    .send()) as string;

  onProgress?.('confirming');
  await waitForSignatureConfirmed({ rpc: erRpc, signature: txSignature });

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
      // biome-ignore lint/suspicious/noExplicitAny: kit Signature branding
      .getSignatureStatuses([signature as any])
      .send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      if (status.err) {
        throw new Error(
          `tx ${signature} failed: ${JSON.stringify(status.err, (_k, v) =>
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
