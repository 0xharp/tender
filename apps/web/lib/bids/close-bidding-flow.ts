/**
 * Buyer-side `rfp_close_bidding` orchestrator.
 *
 * Permissionless after `rfp.bid_close_at`, but in practice we surface the
 * button only on the buyer's view (other roles have no reason to flip it).
 * Single base-layer tx; one wallet popup. Status: Open → Reveal.
 *
 * After the status flip, `BuyerActionPanel` re-renders into `AwardSection`,
 * which lets the buyer decrypt + select a winner.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
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
import { instructions } from '@tender/tender-client';

export type CloseBiddingStage = 'building' | 'awaiting_signature' | 'sending' | 'confirming';

export interface CloseBiddingInput {
  buyer: Address;
  rfpPda: Address;
  signTransactions: (
    ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
  ) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (s: CloseBiddingStage) => void;
}

export interface CloseBiddingResult {
  txSignature: string;
}

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();

export async function closeBidding({
  buyer,
  rfpPda,
  signTransactions,
  rpc,
  onProgress,
}: CloseBiddingInput): Promise<CloseBiddingResult> {
  onProgress?.('building');
  const signer = createNoopSigner(buyer);
  const ix = instructions.getRfpCloseBiddingInstruction({
    anyone: signer,
    rfp: rfpPda,
  });

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(buyer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(ix, m),
  );
  const compiled = compileTransaction(message);
  const txBytes = new Uint8Array(txEncoder.encode(compiled));

  onProgress?.('awaiting_signature');
  const [signed] = await signTransactions({ transaction: txBytes });
  if (!signed) throw new Error('signTransactions returned no outputs');

  onProgress?.('sending');
  const b64 = b64Decoder.decode(signed.signedTransaction);
  // biome-ignore lint/suspicious/noExplicitAny: kit base64 branding
  const sig = (await rpc
    .sendTransaction(b64 as any, { encoding: 'base64', skipPreflight: true })
    .send()) as string;

  onProgress?.('confirming');
  await waitConfirmed(rpc, sig);
  return { txSignature: sig };
}

async function waitConfirmed(rpc: Rpc<SolanaRpcApi>, signature: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await rpc
      // biome-ignore lint/suspicious/noExplicitAny: kit branding
      .getSignatureStatuses([signature as any])
      .send();
    const s = value[0];
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      if (s.err) {
        throw new Error(
          `tx ${signature} failed: ${JSON.stringify(s.err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`tx ${signature} timed out waiting for confirmation`);
}
