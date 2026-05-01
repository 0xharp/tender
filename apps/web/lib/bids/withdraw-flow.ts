/**
 * Provider-side withdrawal — two-phase, both on-chain (Day 6.5).
 *
 *   1. TEE auth (cached) → ER RPC.
 *   2. Build BOTH txs upfront with a noop signer for the provider field:
 *        - Tx 1 (ER): `withdraw_bid` — commit + undelegate the bid + permission
 *          back to base layer. Status flips to `Withdrawn` pre-commit.
 *        - Tx 2 (base): `close_withdrawn_bid` — close the BidCommit, refund
 *          rent to provider, decrement `rfp.bid_count`.
 *   3. signTransactions — single batched wallet popup.
 *   4. Send tx 1 to ER (skipPreflight), await confirm.
 *   5. Poll base-layer until `bid` ownership returns from delegation_program to
 *      the Tender program (the seal-back has landed). Up to 30s.
 *   6. Send tx 2 to base layer (skipPreflight), await confirm.
 *   (no off-chain row to clean up — bids live entirely on-chain post Day 6.5).
 *
 * Why two txs: the magicblock Magic Action runs BEFORE the bid undelegate's
 * ownership transfer is visible to the action handler — Anchor then trips on
 * `AccountOwnedByWrongProgram` (#3007) trying to close the bid. Splitting
 * into two txs lets the second one wait for the seal-back to fully land.
 *
 * Sig profile: 1 message-sign for TEE auth (cached after first), 1 batched
 * tx-sign popup for both txs. Total 1–2 popups per withdraw.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { instructions } from '@tender/tender-client';

import { tenderProgramId } from '@/lib/solana/client';
import { derivePerBidAccounts, ensureTeeAuthToken, ephemeralRpc } from '@/lib/sdks/magicblock';

export type WithdrawBidStage =
  | 'authenticating_er'
  | 'building_txs'
  | 'awaiting_signature'
  | 'submitting_undelegate'
  | 'awaiting_seal_back'
  | 'submitting_close';

/** Wallet-standard sign-transactions feature (one batched popup for many txs). */
export type SignTransactions = (
  ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;

export interface WithdrawBidInput {
  bidPda: Address;
  /** Parent RFP PDA — needed by `close_withdrawn_bid` to decrement bid_count. */
  rfpPda: Address;
  providerWallet: Address;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  signTransactions: SignTransactions;
  /** Base-layer RPC. */
  rpc: Rpc<SolanaRpcApi>;
  /** Legacy partial-signer kept for type compatibility — not used in the new flow. */
  sendingSigner?: TransactionSigner;
  onProgress?: (stage: WithdrawBidStage) => void;
}

export interface WithdrawBidResult {
  /** ER tx that did the commit + undelegate. */
  txSignature: string;
  /** Base-layer tx that closed the bid + decremented bid_count. */
  closeTxSignature: string;
}

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();

/** Max wait for the ER seal-back to land on base layer. */
const SEAL_BACK_POLL_TIMEOUT_MS = 30_000;
const SEAL_BACK_POLL_INTERVAL_MS = 1_000;

export async function withdrawBid({
  bidPda,
  rfpPda,
  providerWallet,
  signMessage,
  signTransactions,
  rpc,
  onProgress,
}: WithdrawBidInput): Promise<WithdrawBidResult> {
  // 1. TEE auth + ER RPC.
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(providerWallet, async (msg) => {
    const { signature } = await signMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  // 2. Build both txs.
  onProgress?.('building_txs');
  const provider = createNoopSigner(providerWallet);
  const perAccounts = await derivePerBidAccounts(bidPda);

  const withdrawIx = await instructions.getWithdrawBidInstructionAsync({
    provider,
    bid: bidPda,
    permission: perAccounts.permission,
  });
  const closeIx = instructions.getCloseWithdrawnBidInstruction({
    provider,
    rfp: rfpPda,
    bid: bidPda,
    // Permission account derived under the permission program (NOT our program).
    // Codama defaults the seeds-program field to TENDER which produces the wrong
    // PDA — pass it explicitly via derivePerBidAccounts.
    permission: perAccounts.permission,
  });

  // Pre-fetch both blockhashes — both have ~60s validity, comfortably covering
  // our up-to-30s seal-back wait.
  const [{ value: erBlockhash }, { value: baseBlockhash }] = await Promise.all([
    erRpc.getLatestBlockhash().send(),
    rpc.getLatestBlockhash().send(),
  ]);

  const erTxBytes = encodeTx([withdrawIx], providerWallet, erBlockhash);
  const baseTxBytes = encodeTx([closeIx], providerWallet, baseBlockhash);

  // 3. Single batched popup.
  onProgress?.('awaiting_signature');
  const outputs = await signTransactions({ transaction: erTxBytes }, { transaction: baseTxBytes });
  const signedEr = outputs[0]?.signedTransaction;
  const signedClose = outputs[1]?.signedTransaction;
  if (!signedEr || !signedClose) {
    throw new Error('signTransactions returned an unexpected number of outputs');
  }

  // 4. Send tx 1 (ER undelegate).
  onProgress?.('submitting_undelegate');
  const txSignature = await sendSigned(signedEr, erRpc);
  await waitForSignatureConfirmed({ rpc: erRpc, signature: txSignature });

  // 5. Wait for the seal-back to flip the bid's owner back to our program on
  // base layer. The seal-back is a separate tx (signed by the validator) that
  // applies the undelegate intent. Poll until the bid account is visible and
  // owned by Tender — that's our cue that close_withdrawn_bid will succeed.
  onProgress?.('awaiting_seal_back');
  await waitForBidUndelegated({ rpc, bidPda });

  // 6. Send tx 2 (base-layer close). After this commits, the bid PDA is closed
  // (rent refunded) and rfp.bid_count is decremented — on-chain is the only
  // source of truth so there's nothing to clean up off-chain.
  onProgress?.('submitting_close');
  const closeTxSignature = await sendSigned(signedClose, rpc);
  await waitForSignatureConfirmed({ rpc, signature: closeTxSignature });

  return { txSignature, closeTxSignature };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
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

/**
 * Poll base-layer for the bid account's owner to flip from the delegation
 * program back to Tender. That signals the ER's seal-back has landed and we
 * can safely send `close_withdrawn_bid`.
 */
async function waitForBidUndelegated({
  rpc,
  bidPda,
}: {
  rpc: Rpc<SolanaRpcApi>;
  bidPda: Address;
}): Promise<void> {
  const deadline = Date.now() + SEAL_BACK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await rpc.getAccountInfo(bidPda, { encoding: 'base64' }).send();
    if (value && value.owner === tenderProgramId) {
      return;
    }
    await new Promise((r) => setTimeout(r, SEAL_BACK_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for the ER seal-back to land — the bid is still owned by the delegation program after ${SEAL_BACK_POLL_TIMEOUT_MS}ms. The undelegate may still complete; you can retry the close step in a moment.`,
  );
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
