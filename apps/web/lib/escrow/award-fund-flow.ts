/**
 * Buyer-side award + fund flow.
 *
 *   1. (optional) reveal_reserve - only if buyer set a reserve at create time
 *   2. select_bid - record winner + contract_value on the rfp
 *   3. fund_project - transfer USDC into escrow PDA + initialize all milestone PDAs
 *
 * Each step is a separate base-layer tx; we batch them through one wallet popup
 * via signTransactions, the same pattern as the Day 6.5 withdraw flow.
 */
import {
  type Address,
  type Instruction,
  type ProgramDerivedAddress,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { instructions } from '@tender/tender-client';

import { buildBidBindingMessage } from '@/lib/crypto/derive-ephemeral-bid-wallet';
import {
  fetchRfp,
  findProviderReputationPda,
  rfpStatusToString,
} from '@/lib/solana/chain-reads';
import { tenderProgramId } from '@/lib/solana/client';

const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111' as Address;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111' as Address;

/**
 * Build a ComputeBudget `SetComputeUnitLimit` ix.
 *
 * Default per-tx CU limit is 200_000. fund_project does heavy work (init N
 * milestone PDAs + token-program CPI for the escrow transfer) and runs over.
 * We bump to 1.4M (Solana's per-tx max) to give it all the headroom it needs;
 * unused units cost nothing. Same applies to select_bid in private mode where
 * the ix loads the instructions sysvar + parses the SigVerify chain.
 *
 * Layout: 1-byte discriminator (2 = SetComputeUnitLimit) + u32 LE units.
 */
function setComputeUnitLimitIx(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data };
}

/** Manually-derived milestone PDA (codama can't model the dynamic-index seed). */
async function findMilestonePda(rfp: Address, index: number): Promise<ProgramDerivedAddress> {
  const addressEncoder = getAddressEncoder();
  const utf = getUtf8Encoder();
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('milestone'), addressEncoder.encode(rfp), new Uint8Array([index])],
  });
}

export type AwardStage =
  | 'building_txs'
  | 'awaiting_signature'
  | 'sending_reveal'
  | 'sending_select'
  | 'sending_fund'
  | 'done';

export interface AwardFundInput {
  buyer: Address;
  rfpPda: Address;
  winnerBidPda: Address;
  /** The provider's MAIN wallet - for public RFPs this equals the bid signer.
   *  For private RFPs the buyer learns it from the decrypted bid envelope. */
  winnerProviderWallet: Address;
  /** The bid PDA's actual signer (= bid.provider on-chain). For public RFPs
   *  this equals winnerProviderWallet. For private RFPs this is the bid's
   *  ephemeral wallet - used to detect mode + (when set) trigger ed25519 verify. */
  bidSignerWallet: Address;
  /** Required when bidSignerWallet != winnerProviderWallet (private RFPs).
   *  Buyer extracts this from the decrypted bid envelope's `_bidBinding` field.
   *  64 bytes ed25519 signature over the canonical binding message. */
  bidBindingSignature?: Uint8Array;
  contractValue: bigint;
  /** USDC mint to fund with. */
  mint: Address;
  /** If buyer set a reserve at create time, pass the reveal pieces here. */
  reserveReveal?: { amount: bigint; nonceHex: string };
  /** Per-milestone payout amounts (USDC base units). 1..=8 entries that
   *  sum to exactly `contractValue`. Sourced from the WINNING bid plaintext
   *  - these are the exact amounts the provider quoted, written to the rfp
   *  by `select_bid` so `fund_project` initializes each milestone with no
   *  rounding loss. */
  milestoneAmounts: bigint[];
  /** Per-milestone delivery duration (seconds). Length must equal
   *  `milestoneAmounts.length`. 0 = no deadline → cancel_late_milestone
   *  unavailable for that milestone. Sourced from bid plaintext durationDays. */
  milestoneDurationsSecs: bigint[];
  signTransactions: (
    ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
  ) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (s: AwardStage) => void;
}

export interface AwardFundResult {
  revealTxSignature?: string;
  selectTxSignature: string;
  fundTxSignature: string;
}

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();

export async function awardAndFund(input: AwardFundInput): Promise<AwardFundResult> {
  const {
    buyer,
    rfpPda,
    winnerBidPda,
    winnerProviderWallet,
    bidSignerWallet,
    bidBindingSignature,
    contractValue,
    mint,
    reserveReveal,
    milestoneAmounts,
    milestoneDurationsSecs,
    signTransactions,
    rpc,
    onProgress,
  } = input;
  const milestoneCount = milestoneAmounts.length;
  if (milestoneCount < 1 || milestoneCount > 8) {
    throw new Error(`milestoneAmounts must have 1–8 entries, got ${milestoneCount}.`);
  }
  const amtSum = milestoneAmounts.reduce((a, b) => a + b, 0n);
  if (amtSum !== contractValue) {
    throw new Error(
      `milestoneAmounts must sum to exactly contractValue (${contractValue}); got ${amtSum}.`,
    );
  }
  if (milestoneAmounts.some((a) => a <= 0n)) {
    throw new Error('Every milestone amount must be > 0.');
  }
  if (milestoneDurationsSecs.length !== milestoneCount) {
    throw new Error(
      `milestoneDurationsSecs length (${milestoneDurationsSecs.length}) must equal milestoneAmounts length (${milestoneCount}).`,
    );
  }
  if (milestoneDurationsSecs.some((d) => d < 0n)) {
    throw new Error('milestoneDurationsSecs entries must be ≥ 0 (use 0 for no deadline).');
  }

  onProgress?.('building_txs');
  const signer: TransactionSigner = createNoopSigner(buyer);
  const isPrivateMode = winnerProviderWallet !== bidSignerWallet;
  if (isPrivateMode && (!bidBindingSignature || bidBindingSignature.byteLength !== 64)) {
    throw new Error(
      'awardAndFund: private-mode RFPs require a 64-byte bidBindingSignature. ' +
        'Buyer must extract it from the decrypted bid envelope.',
    );
  }

  // Pre-flight: read current RFP status. The flow has THREE on-chain steps
  // (reveal_reserve, select_bid, fund_project), each with its own status
  // gate. If a previous attempt landed select_bid but failed at fund_project
  // (e.g., compute-budget exhaustion before we set the explicit limit), the
  // RFP is now `Awarded` and re-running select_bid would trip InvalidRfpStatus.
  // Skip the steps already past their gate — turns this into an idempotent
  // retry.
  const currentRfp = await fetchRfp(rfpPda);
  if (!currentRfp) {
    throw new Error(`awardAndFund: RFP ${rfpPda} not found on-chain.`);
  }
  const currentStatus = rfpStatusToString(currentRfp.status);
  const needsSelect = currentStatus === 'reveal' || currentStatus === 'bidsclosed';
  const needsFund = currentStatus === 'awarded' || needsSelect;
  // reveal_reserve gate matches select_bid (Reveal/BidsClosed) AND requires
  // an unrevealed reserve. If select already happened the buyer can't reveal
  // (status moved past), so we suppress.
  const needsReveal = needsSelect && !!reserveReveal;
  if (!needsFund) {
    throw new Error(
      `awardAndFund: RFP is in status '${currentStatus}', past the awardable window. ` +
        'Nothing to do — refresh the page to see the current state.',
    );
  }

  const { value: blockhash } = await rpc.getLatestBlockhash().send();

  const txs: Uint8Array[] = [];
  const labels: ('reveal' | 'select' | 'fund')[] = [];

  if (needsReveal) {
    const ix = instructions.getRevealReserveInstruction({
      buyer: signer,
      rfp: rfpPda,
      reserveAmount: reserveReveal!.amount,
      reserveNonce: hexToBytes(reserveReveal!.nonceHex),
    });
    txs.push(encodeTx([ix], buyer, blockhash));
    labels.push('reveal');
  }

  const [providerRep] = await findProviderReputationPda(winnerProviderWallet);
  const selectIx = await instructions.getSelectBidInstructionAsync({
    buyer: signer,
    rfp: rfpPda,
    bid: winnerBidPda,
    winnerProvider: winnerProviderWallet,
    providerReputation: providerRep,
    contractValue,
    milestoneCount,
    milestoneAmounts,
    milestoneDurationsSecs,
  });

  if (needsSelect) {
    if (isPrivateMode && bidBindingSignature) {
      // Private mode: prepend Ed25519SigVerify ix at index 0 of the select tx.
      // The on-chain `select_bid` reads the instructions sysvar, validates this
      // ix matches the canonical binding message, and only then accepts
      // winnerProvider as the verified main wallet.
      const bindingMessage = buildBidBindingMessage(rfpPda, winnerBidPda, winnerProviderWallet);
      const ed25519Ix = buildEd25519SigVerifyIx({
        pubkey: winnerProviderWallet,
        signature: bidBindingSignature,
        message: bindingMessage,
      });
      txs.push(
        encodeTx([setComputeUnitLimitIx(1_400_000), ed25519Ix, selectIx], buyer, blockhash),
      );
    } else {
      txs.push(encodeTx([setComputeUnitLimitIx(1_400_000), selectIx], buyer, blockhash));
    }
    labels.push('select');
  }

  // fund_project requires the milestone PDAs as remaining accounts.
  // We build their pdas client-side. The ix is via the codama helper plus
  // direct extension of remaining accounts.
  const milestonePdas: Address[] = [];
  for (let i = 0; i < milestoneCount; i++) {
    const [pda] = await findMilestonePda(rfpPda, i);
    milestonePdas.push(pda);
  }

  const fundIx = await instructions.getFundProjectInstructionAsync({
    buyer: signer,
    rfp: rfpPda,
    mint,
  });
  // Manually append remaining-accounts. Codama doesn't model dynamic-length
  // remaining_accounts, so we extend the accounts array directly.
  const fundIxWithExtras = {
    ...fundIx,
    accounts: [
      ...fundIx.accounts,
      ...milestonePdas.map((address) => ({
        address,
        role: 1, // writable, non-signer
      })),
    ],
  } as typeof fundIx;
  txs.push(encodeTx([setComputeUnitLimitIx(1_400_000), fundIxWithExtras], buyer, blockhash));
  labels.push('fund');

  onProgress?.('awaiting_signature');
  const signed = await signTransactions(...txs.map((tx) => ({ transaction: tx })));

  const result: AwardFundResult = {
    selectTxSignature: '',
    fundTxSignature: '',
  };

  for (let i = 0; i < signed.length; i++) {
    const label = labels[i]!;
    if (label === 'reveal') onProgress?.('sending_reveal');
    if (label === 'select') onProgress?.('sending_select');
    if (label === 'fund') onProgress?.('sending_fund');
    const sigBytes = signed[i]?.signedTransaction;
    const sig = await sendSigned(sigBytes, rpc);
    await waitConfirmed(rpc, sig);
    if (label === 'reveal') result.revealTxSignature = sig;
    if (label === 'select') result.selectTxSignature = sig;
    if (label === 'fund') result.fundTxSignature = sig;
  }

  onProgress?.('done');
  void tenderProgramId; // future: verification reads
  return result;
}

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
  return new Uint8Array(txEncoder.encode(compileTransaction(message)));
}

async function sendSigned(bytes: Uint8Array, rpc: Rpc<SolanaRpcApi>): Promise<string> {
  const b64 = b64Decoder.decode(bytes);
  const sig = await rpc
    .sendTransaction(b64 as never, { encoding: 'base64', skipPreflight: true })
    .send();
  return sig as string;
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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build a Solana Ed25519SigVerify ix with one signature, all data inline.
 * Layout (matches what the program parses in select_bid::verify_binding_signature):
 *   byte 0:        num_signatures = 1
 *   byte 1:        padding = 0
 *   bytes 2..16:   SignatureOffsets (14 bytes, all u16 LE):
 *                    sig_offset=16, sig_ix_index=0xFFFF (this ix),
 *                    pubkey_offset=80, pubkey_ix_index=0xFFFF,
 *                    msg_offset=112, msg_size=N, msg_ix_index=0xFFFF
 *   bytes 16..80:  signature (64 bytes)
 *   bytes 80..112: pubkey (32 bytes)
 *   bytes 112..:   message (N bytes)
 */
function buildEd25519SigVerifyIx({
  pubkey,
  signature,
  message,
}: { pubkey: Address; signature: Uint8Array; message: Uint8Array }): Instruction {
  if (signature.byteLength !== 64) throw new Error('signature must be 64 bytes');
  const addressEncoder = getAddressEncoder();
  const pubkeyBytes = new Uint8Array(addressEncoder.encode(pubkey));
  if (pubkeyBytes.byteLength !== 32) throw new Error('pubkey must encode to 32 bytes');

  const msgSize = message.byteLength;
  const data = new Uint8Array(112 + msgSize);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  // SignatureOffsets (LE u16):
  const view = new DataView(data.buffer);
  view.setUint16(2, 16, true); // sig_offset
  view.setUint16(4, 0xffff, true); // sig_ix_index = self
  view.setUint16(6, 80, true); // pubkey_offset
  view.setUint16(8, 0xffff, true); // pubkey_ix_index = self
  view.setUint16(10, 112, true); // msg_offset
  view.setUint16(12, msgSize, true); // msg_size
  view.setUint16(14, 0xffff, true); // msg_ix_index = self
  data.set(signature, 16);
  data.set(pubkeyBytes, 80);
  data.set(message, 112);

  return {
    programAddress: ED25519_PROGRAM_ID,
    accounts: [],
    data,
  };
}
