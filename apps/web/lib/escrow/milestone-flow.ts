/**
 * Milestone lifecycle helpers - provider start/submit, buyer accept/request_changes/reject,
 * permissionless auto_release, both cancel paths, dispute resolution, and mode-3 attest_win.
 *
 * Codama can't auto-derive PDAs whose seeds include dynamic args (the milestone index),
 * so we use sync ix variants and pass every account explicitly.
 */
import {
  type Address,
  type ProgramDerivedAddress,
  type Rpc,
  type SolanaRpcApi,
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

import { tenderProgramId } from '@/lib/solana/client';

const txEncoder = getTransactionEncoder();
const b64Decoder = getBase64Decoder();
const addressEncoder = getAddressEncoder();
const utf = getUtf8Encoder();

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

export type SignTransactions = (
  ...inputs: ReadonlyArray<{ transaction: Uint8Array }>
) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;

/* -------------------------------------------------------------------------- */
/* PDA derivations                                                             */
/* -------------------------------------------------------------------------- */

async function findMilestonePda(rfp: Address, index: number): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('milestone'), addressEncoder.encode(rfp), new Uint8Array([index])],
  });
}

async function findEscrowPda(rfp: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('escrow'), addressEncoder.encode(rfp)],
  });
}

async function findBuyerRepPda(buyer: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('buyer_rep'), addressEncoder.encode(buyer)],
  });
}

async function findProviderRepPda(provider: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('provider_rep'), addressEncoder.encode(provider)],
  });
}

async function findTreasuryPda(): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('treasury')],
  });
}

/**
 * Build an ATA-program `CreateIdempotent` ix.
 *
 * Used to ensure the recipient's associated token account exists before any
 * milestone-settlement ix that transfers USDC into it. If the ATA already
 * exists this ix is a cheap no-op (~30 CU); if not, it creates the account
 * with the buyer paying rent. We prepend this defensively before
 * `accept_milestone`, `auto_release_milestone`, and the dispute settlements,
 * because brand-new providers often have no USDC ATA yet (Anchor would
 * otherwise reject with `AccountNotInitialized`/3012).
 *
 * Discriminator: 1 = CreateIdempotent.
 */
function createAtaIdempotentIx(payer: Address, owner: Address, mint: Address, ata: Address) {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: payer, role: 3 }, // writable, signer
      { address: ata, role: 1 }, // writable, non-signer
      { address: owner, role: 0 }, // readonly, non-signer
      { address: mint, role: 0 },
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: new Uint8Array([1]),
  };
}

async function findAta(mint: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [
      addressEncoder.encode(owner),
      addressEncoder.encode(TOKEN_PROGRAM_ID),
      addressEncoder.encode(mint),
    ],
  });
  return pda;
}

/* -------------------------------------------------------------------------- */
/* Provider actions                                                            */
/* -------------------------------------------------------------------------- */

export async function startMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const ix = instructions.getStartMilestoneInstruction({
    provider: noop,
    rfp: input.rfpPda,
    milestone,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

export async function submitMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const ix = instructions.getSubmitMilestoneInstruction({
    provider: noop,
    rfp: input.rfpPda,
    milestone,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

/* -------------------------------------------------------------------------- */
/* Buyer review actions                                                        */
/* -------------------------------------------------------------------------- */

export async function acceptMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [treasury] = await findTreasuryPda();
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const escrowAta = await findAta(input.mint, escrow);
  const treasuryAta = await findAta(input.mint, treasury);
  const providerAta = await findAta(input.mint, input.providerPayoutWallet);

  const [buyerRep] = await findBuyerRepPda(input.signer);
  const ix = instructions.getAcceptMilestoneInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    providerAta,
    treasury,
    treasuryAta,
    providerReputation: providerRep,
    buyerReputation: buyerRep,
    milestoneIndex: input.milestoneIndex,
  });
  // Defensively ensure both recipient ATAs exist - the provider's (first
  // payout) and the treasury's (first platform-fee collection on this
  // devnet). Anchor would otherwise reject accept_milestone with
  // AccountNotInitialized (3012) on whichever is missing. The idempotent
  // variant is a no-op (~30 CU) if the ATA already exists. Buyer pays the
  // rent (~0.002 SOL each) when creating.
  const ensureProviderAta = createAtaIdempotentIx(
    input.signer,
    input.providerPayoutWallet,
    input.mint,
    providerAta,
  );
  const ensureTreasuryAta = createAtaIdempotentIx(input.signer, treasury, input.mint, treasuryAta);
  return await sendMany(
    [ensureProviderAta, ensureTreasuryAta, ix],
    input.signer,
    input.rpc,
    input.signTransactions,
  );
}

export async function requestChanges(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const ix = instructions.getRequestChangesInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

export async function rejectMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [buyerRep] = await findBuyerRepPda(input.signer);
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const ix = instructions.getRejectMilestoneInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    buyerReputation: buyerRep,
    providerReputation: providerRep,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

/* -------------------------------------------------------------------------- */
/* Permissionless / cancel paths                                               */
/* -------------------------------------------------------------------------- */

export async function autoReleaseMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  /** Buyer wallet for the buyer-reputation PDA derivation. Caller must
   *  supply since auto-release is permissionless and the signer may not be
   *  the buyer. */
  buyerWallet: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [treasury] = await findTreasuryPda();
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const [buyerRep] = await findBuyerRepPda(input.buyerWallet);
  const escrowAta = await findAta(input.mint, escrow);
  const treasuryAta = await findAta(input.mint, treasury);
  const providerAta = await findAta(input.mint, input.providerPayoutWallet);

  const ix = instructions.getAutoReleaseMilestoneInstruction({
    payer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    providerAta,
    treasury,
    treasuryAta,
    providerReputation: providerRep,
    buyerReputation: buyerRep,
    milestoneIndex: input.milestoneIndex,
  });
  // Same as acceptMilestone: provider + treasury ATAs may not exist yet.
  const ensureProviderAta = createAtaIdempotentIx(
    input.signer,
    input.providerPayoutWallet,
    input.mint,
    providerAta,
  );
  const ensureTreasuryAta = createAtaIdempotentIx(input.signer, treasury, input.mint, treasuryAta);
  return await sendMany(
    [ensureProviderAta, ensureTreasuryAta, ix],
    input.signer,
    input.rpc,
    input.signTransactions,
  );
}

export async function cancelWithNotice(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [buyerRep] = await findBuyerRepPda(input.signer);
  const escrowAta = await findAta(input.mint, escrow);
  const buyerAta = await findAta(input.mint, input.signer);

  const ix = instructions.getCancelWithNoticeInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    buyerAta,
    buyerReputation: buyerRep,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

/** Buyer cancels a Started milestone whose delivery_deadline has passed.
 *  Full refund, no penalty; provider rep takes a `late_milestones` ding. */
export async function cancelLateMilestone(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [buyerRep] = await findBuyerRepPda(input.signer);
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const escrowAta = await findAta(input.mint, escrow);
  const buyerAta = await findAta(input.mint, input.signer);

  const ix = instructions.getCancelLateMilestoneInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    buyerAta,
    buyerReputation: buyerRep,
    providerReputation: providerRep,
    milestoneIndex: input.milestoneIndex,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

export async function cancelWithPenalty(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [buyerRep] = await findBuyerRepPda(input.signer);
  const escrowAta = await findAta(input.mint, escrow);
  const buyerAta = await findAta(input.mint, input.signer);
  const providerAta = await findAta(input.mint, input.providerPayoutWallet);

  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const ix = instructions.getCancelWithPenaltyInstruction({
    buyer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    buyerAta,
    providerAta,
    buyerReputation: buyerRep,
    providerReputation: providerRep,
    milestoneIndex: input.milestoneIndex,
  });
  // Brand-new providers may not have a USDC ATA yet - prepend an idempotent
  // create so the penalty payout doesn't trip AccountNotInitialized (3012).
  // Buyer's ATA already exists (they funded the escrow), so we only need
  // the provider's. See note in `acceptMilestone` on why we do this.
  const ensureProviderAta = createAtaIdempotentIx(
    input.signer,
    input.providerPayoutWallet,
    input.mint,
    providerAta,
  );
  return await sendMany([ensureProviderAta, ix], input.signer, input.rpc, input.signTransactions);
}

export async function markBuyerGhosted(input: {
  signer: Address;
  rfpPda: Address;
  buyerWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [buyerRep] = await findBuyerRepPda(input.buyerWallet);
  const ix = instructions.getMarkBuyerGhostedInstruction({
    payer: noop,
    rfp: input.rfpPda,
    buyerReputation: buyerRep,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

/**
 * Permissionless: flips a stuck RFP (status = Reveal/BidsClosed but past
 * `reveal_close_at`) to RfpStatus::Expired. Anyone can call - typically the
 * buyer (acknowledging they let the window pass) or any provider whose bid
 * is otherwise stuck. No rent flows.
 */
export async function expireRfp(input: {
  signer: Address;
  rfpPda: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const ix = instructions.getExpireRfpInstruction({
    caller: noop,
    rfp: input.rfpPda,
  });
  return await sendOne(ix, input.signer, input.rpc, input.signTransactions);
}

/* -------------------------------------------------------------------------- */
/* Dispute resolution                                                          */
/* -------------------------------------------------------------------------- */

export async function proposeDisputeSplit(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  splitToProviderBps: number;
  mint: Address;
  buyerWallet: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [treasury] = await findTreasuryPda();
  const escrowAta = await findAta(input.mint, escrow);
  const buyerAta = await findAta(input.mint, input.buyerWallet);
  const providerAta = await findAta(input.mint, input.providerPayoutWallet);
  const treasuryAta = await findAta(input.mint, treasury);

  const [buyerRep] = await findBuyerRepPda(input.buyerWallet);
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const ix = instructions.getResolveDisputeInstruction({
    party: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    providerAta,
    buyerAta,
    treasury,
    treasuryAta,
    buyerReputation: buyerRep,
    providerReputation: providerRep,
    milestoneIndex: input.milestoneIndex,
    splitToProviderBps: input.splitToProviderBps,
  });
  // Provider + treasury ATAs may not exist yet on first dispute settlement.
  // Buyer's ATA exists (they funded escrow). Either party can call this ix,
  // so the signer pays for any ATA rent that's still missing.
  const ensureProviderAta = createAtaIdempotentIx(
    input.signer,
    input.providerPayoutWallet,
    input.mint,
    providerAta,
  );
  const ensureTreasuryAta = createAtaIdempotentIx(input.signer, treasury, input.mint, treasuryAta);
  return await sendMany(
    [ensureProviderAta, ensureTreasuryAta, ix],
    input.signer,
    input.rpc,
    input.signTransactions,
  );
}

export async function disputeDefaultSplit(input: {
  signer: Address;
  rfpPda: Address;
  milestoneIndex: number;
  mint: Address;
  buyerWallet: Address;
  providerPayoutWallet: Address;
  signTransactions: SignTransactions;
  rpc: Rpc<SolanaRpcApi>;
}): Promise<string> {
  const noop = createNoopSigner(input.signer);
  const [milestone] = await findMilestonePda(input.rfpPda, input.milestoneIndex);
  const [escrow] = await findEscrowPda(input.rfpPda);
  const [treasury] = await findTreasuryPda();
  const escrowAta = await findAta(input.mint, escrow);
  const buyerAta = await findAta(input.mint, input.buyerWallet);
  const providerAta = await findAta(input.mint, input.providerPayoutWallet);
  const treasuryAta = await findAta(input.mint, treasury);

  const [buyerRep] = await findBuyerRepPda(input.buyerWallet);
  const [providerRep] = await findProviderRepPda(input.providerPayoutWallet);
  const ix = instructions.getDisputeDefaultSplitInstruction({
    payer: noop,
    rfp: input.rfpPda,
    milestone,
    escrow,
    mint: input.mint,
    escrowAta,
    providerAta,
    buyerAta,
    treasury,
    treasuryAta,
    buyerReputation: buyerRep,
    providerReputation: providerRep,
    milestoneIndex: input.milestoneIndex,
  });
  // 50/50 default split touches all three parties' ATAs. Buyer's exists;
  // provider's + treasury's may not on first call.
  const ensureProviderAta = createAtaIdempotentIx(
    input.signer,
    input.providerPayoutWallet,
    input.mint,
    providerAta,
  );
  const ensureTreasuryAta = createAtaIdempotentIx(input.signer, treasury, input.mint, treasuryAta);
  return await sendMany(
    [ensureProviderAta, ensureTreasuryAta, ix],
    input.signer,
    input.rpc,
    input.signTransactions,
  );
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

async function sendOne(
  // biome-ignore lint/suspicious/noExplicitAny: ix parameterizations vary
  ix: any,
  feePayer: Address,
  rpc: Rpc<SolanaRpcApi>,
  signTransactions: SignTransactions,
): Promise<string> {
  return sendMany([ix], feePayer, rpc, signTransactions);
}

async function sendMany(
  // biome-ignore lint/suspicious/noExplicitAny: ix parameterizations vary
  ixs: any[],
  feePayer: Address,
  rpc: Rpc<SolanaRpcApi>,
  signTransactions: SignTransactions,
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    // biome-ignore lint/suspicious/noExplicitAny: kit blockhash branding
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash as any, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = new Uint8Array(txEncoder.encode(compileTransaction(message)));
  const [signed] = await signTransactions({ transaction: tx });
  if (!signed) throw new Error('signTransactions returned no outputs');
  const b64 = b64Decoder.decode(signed.signedTransaction);
  const sig = await rpc
    .sendTransaction(b64 as never, { encoding: 'base64', skipPreflight: true })
    .send();
  await waitConfirmed(rpc, sig as string);
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
  throw new Error(`tx ${signature} timed out`);
}

void SYSTEM_PROGRAM_ID; // reserved for future ix
