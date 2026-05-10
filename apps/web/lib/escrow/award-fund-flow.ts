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

import { TENDER_PROGRAM_ID } from '@tender/shared';

import { fetchRfp, findProviderReputationPda, rfpStatusToString } from '@/lib/solana/chain-reads';
import { tenderProgramId } from '@/lib/solana/client';

/**
 * Build the canonical fund-authorization message that the buyer signs to
 * permit a fund_project tx in v2. Must match byte-for-byte the on-chain
 * `programs/tender/src/instructions/fund_project.rs::build_fund_auth_message`.
 *
 * Format (newline-delimited, deterministic):
 *
 *     tender-fund-auth-v1
 *     program=<base58 program id>
 *     rfp=<base58 rfp pda>
 *     contract_value=<u64 decimal>
 */
function buildFundAuthMessage(rfpPda: Address, contractValue: bigint): Uint8Array {
  const text = [
    'tender-fund-auth-v1',
    `program=${TENDER_PROGRAM_ID}`,
    `rfp=${rfpPda}`,
    `contract_value=${contractValue.toString()}`,
  ].join('\n');
  return new TextEncoder().encode(text);
}

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
  | 'signing_fund_auth'
  | 'awaiting_signature'
  | 'sending_reveal'
  | 'sending_select'
  | 'sending_fund'
  | 'topping_up_signer'
  | 'done';

export interface AwardFundInput {
  buyer: Address;
  rfpPda: Address;
  winnerBidPda: Address;
  /** v2 claim-based: equals the bid signer in both modes. Public mode:
   *  bid signed by the provider's main wallet. Private bidder mode: bid
   *  signed by the bidder ephemeral. The program records this on
   *  `rfp.winner_provider`; every settlement-path ix sends payouts to its
   *  ATA. The provider's main wallet stays unlinked in private mode
   *  until they run attest_win as a separate post-completion claim. */
  winnerProviderWallet: Address;
  /** Same as winnerProviderWallet in v2 claim-based mode — kept as a
   *  distinct field so callers can highlight "bid signer" in UI copy. */
  bidSignerWallet: Address;
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
  /**
   * v2: buyer's wallet signs the canonical `tender-fund-auth-v1` message
   * so the on-chain `fund_project` ix can verify (via Ed25519SigVerify
   * introspection) that the funder is acting with buyer's authorization.
   * In public buyer mode this is the buyer's main wallet; in private
   * buyer mode (future) this is the HD-derived ephemeral buyer.
   */
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
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
    contractValue,
    mint,
    reserveReveal,
    milestoneAmounts,
    milestoneDurationsSecs,
    signTransactions,
    signMessage,
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
  // v2 claim-based: callers always pass winnerProviderWallet === bidSignerWallet.
  // The on-chain `select_bid` accepts this via its public-mode branch (no
  // binding-sig required when args.winner_provider == bid.provider). For
  // public bidder mode, bid.provider IS the main wallet → unchanged. For
  // private bidder mode, bid.provider is the eph → winner_provider records
  // the eph; the provider claims into main rep later via attest_win.
  void bidSignerWallet; // kept in signature for callers; equality with winnerProviderWallet is enforced upstream

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
      `awardAndFund: RFP is in status '${currentStatus}', past the awardable window. Nothing to do - refresh the page to see the current state.`,
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
    txs.push(encodeTx([setComputeUnitLimitIx(1_400_000), selectIx], buyer, blockhash));
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

  // v2 — fund_project requires the buyer to sign a canonical fund-auth
  // message; we prepend an Ed25519SigVerify ix so the on-chain handler
  // can introspect the sysvar and confirm buyer authorization. In public
  // buyer mode (today) the same wallet plays both buyer + funder roles,
  // so we ask its signMessage callback for the auth signature here.
  //
  // Two consecutive wallet interactions: signMessage now, then
  // signTransactions a few lines down. Surface this as its own stage
  // so the UI can tell the user "1 of 2" instead of a single
  // "awaiting signature" that hides the second popup.
  onProgress?.('signing_fund_auth');
  const fundAuthMessage = buildFundAuthMessage(rfpPda, contractValue);
  const { signature: fundAuthSignature } = await signMessage({ message: fundAuthMessage });
  // Small breathing room for the wallet UI between the two sign calls.
  // Some wallets (Phantom observed) silently queue the second sign
  // request if it comes <50ms after the first resolves — the popup
  // never appears and the awaitsignTransactions hangs indefinitely.
  // 150ms is imperceptible to the user but past every wallet's
  // single-flight debounce window we've seen in practice.
  await new Promise((r) => setTimeout(r, 150));
  const fundEd25519Ix = buildEd25519SigVerifyIx({
    pubkey: buyer,
    signature: fundAuthSignature,
    message: fundAuthMessage,
  });

  const fundIx = await instructions.getFundProjectInstructionAsync({
    funder: signer,
    buyer: buyer,
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
  txs.push(
    encodeTx([setComputeUnitLimitIx(1_400_000), fundEd25519Ix, fundIxWithExtras], buyer, blockhash),
  );
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

/* -------------------------------------------------------------------------- */
/* fundEscrowPrivately — v2 Cloak-shielded fund flow.                         */
/*                                                                             */
/* Called AFTER the public award flow (select+reveal already landed). Runs    */
/* the standalone fund_project step via:                                       */
/*   1. Buyer signs the canonical Ed25519 fund-auth message.                  */
/*   2. Funding ephemeral derived from keychain (deterministic per rfp_pda).  */
/*   3. Cloak shielded USDC: main wallet's USDC ATA → ephemeral's USDC ATA.   */
/*      Includes ALT setup, idempotent ATA-create, deposit, relay-paid        */
/*      withdraw. ~3 wallet popups for the user (ATA + ALT + Cloak deposit).  */
/*   4. fund_project tx signed locally by funding ephemeral keypair (no       */
/*      popup), with the Ed25519SigVerify ix prepended for buyer auth.        */
/* -------------------------------------------------------------------------- */

export interface FundEscrowPrivatelyInput {
  /** Whoever the program treats as the buyer (rfp.buyer). In public-buyer
   *  mode this is the connected wallet's address; in private-buyer mode
   *  this is the HD-derived ephemeral_buyer pubkey. */
  buyer: Address;
  rfpPda: Address;
  contractValue: bigint;
  /** USDC mint — Cloak's mock USDC on devnet. */
  mint: Address;
  milestoneAmounts: bigint[];
  milestoneDurationsSecs: bigint[];
  /** Function that signs the canonical fund-auth message. In public buyer
   *  mode this is the wallet adapter's signMessage hook; in private buyer
   *  mode it's a local sign with the ephemeral_buyer keypair. */
  signFundAuth: (message: Uint8Array) => Promise<Uint8Array>;
  /** Wallet's signTransaction (single-tx variant — what Cloak expects).
   *  Build via `buildCloakSignTransactionAdapter` in `lib/wallet/sign.ts`
   *  so the signing path is wallet-standard-portable. */
  signTransaction: <
    T extends
      | import('@solana/web3.js').Transaction
      | import('@solana/web3.js').VersionedTransaction,
  >(
    tx: T,
  ) => Promise<T>;
  /** Wallet's signMessage (Cloak's viewing-key registration uses it). */
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Funding ephemeral — derived via the keychain, holds the SOL/USDC for
   *  the fund tx. We sign locally with this keypair so no Phantom popup
   *  for the actual fund_project tx. */
  fundingEphemeral: import('@solana/web3.js').Keypair;
  /** v2 — when provided, the funder ephemeral's USDC ATA + the Cloak ALT
   *  are signed AND paid by this keypair (typically the buyer ephemeral,
   *  which already holds Cloak-laundered SOL from RFP create) instead of
   *  the main wallet. Closes the on-chain `tx fee payer = main wallet`
   *  leak on the bootstrap txs. The Cloak deposit itself is still signed
   *  by main wallet — that's unavoidable since USDC source is main's
   *  ATA. Caller must preflight that this keypair has enough SOL to
   *  cover ~0.005 SOL of rent + fees. */
  bootstrapKeypair?: import('@solana/web3.js').Keypair;
  /** Buyer's main wallet — pays Cloak deposit fees. */
  buyerWallet: Address;
  rpc: Rpc<SolanaRpcApi>;
  /** web3.js Connection — required by Cloak SDK + spl-token. Build with
   *  `new Connection(NEXT_PUBLIC_SOLANA_RPC_URL, 'confirmed')`. */
  connection: import('@solana/web3.js').Connection;
  onProgress?: (s: PrivateFundStage) => void;
}

export type PrivateFundStage =
  | 'preparing'
  | 'signing_auth'
  | 'cloak_funding_ata'
  | 'cloak_alt_setup'
  | 'cloak_deposit'
  | 'cloak_withdraw'
  | 'sending_fund'
  | 'done';

export interface FundEscrowPrivatelyResult {
  fundTxSignature: string;
  cloakDepositSig: string;
  cloakWithdrawSig: string;
  fundingEphemeralAta: string;
}

export async function fundEscrowPrivately(
  input: FundEscrowPrivatelyInput,
): Promise<FundEscrowPrivatelyResult> {
  const {
    buyer,
    rfpPda,
    contractValue,
    mint,
    signFundAuth,
    signTransaction,
    signMessage,
    fundingEphemeral,
    bootstrapKeypair,
    buyerWallet,
    rpc,
    connection,
    onProgress,
  } = input;

  onProgress?.('preparing');

  // Step 1: buyer signs the canonical Ed25519 fund-auth message. The
  // on-chain fund_project ix verifies this via Ed25519SigVerify
  // introspection, binding `funder ≠ rfp.buyer` to a real authorization.
  onProgress?.('signing_auth');
  const fundAuthMessage = buildFundAuthMessage(rfpPda, contractValue);
  const fundAuthSignature = await signFundAuth(fundAuthMessage);

  // Step 2: shielded USDC fund. Drains contractValue from the buyer's
  // main wallet's USDC ATA into Cloak's pool, then withdraws to the
  // funding ephemeral's USDC ATA. With `bootstrapKeypair` provided
  // (HD-private path), ATA + ALT are signed locally by that keypair —
  // only the Cloak deposit pops the wallet (1 popup). Without it
  // (legacy public-buyer path), all three (ATA + ALT + deposit) pop.
  const { fundEphemeralUsdcAta } = await import('@/lib/sdks/cloak');
  const { PublicKey } = await import('@solana/web3.js');
  // Gross up the deposit by Cloak's protocol fee so the relay-paid
  // withdraw lands AT LEAST `contractValue` on the funder's USDC ATA.
  // Cloak charges a variable fee of `amount * 3 / 1000` (0.3 %) on SPL
  // deposits — empirically observed: $10 in → $9.97 out (devnet mock
  // USDC). Without this gross-up, fund_project fails with SPL Token
  // error #1 (InsufficientFunds) because it tries to TransferChecked
  // exactly `contractValue` from a slightly under-funded ATA. Tiny
  // overshoot (1–2 base units) sits as dust on the funder ATA — the
  // user can sweep it via the dashboard. Formula:
  //   deposit ≥ ceil(contractValue * 1000 / 997) + 1 buffer
  // = (contractValue * 1000 + 996) / 997 + 1, integer-divided.
  const grossDeposit = (contractValue * 1000n + 996n) / 997n + 1n;
  onProgress?.('cloak_funding_ata');
  const cloakResult = await fundEphemeralUsdcAta({
    walletPublicKey: new PublicKey(buyerWallet),
    signTransaction,
    // Cloak's WalletAdapterSignMessage expects (msg: Uint8Array) =>
    // Promise<Uint8Array>; our React hook returns {signature}. Adapter:
    signMessage: async (message: Uint8Array) => (await signMessage({ message })).signature,
    ephemeralPubkey: fundingEphemeral.publicKey,
    depositMicroUsdc: grossDeposit,
    mint: new PublicKey(mint),
    ephemeralBootstrapKeypair: bootstrapKeypair,
    connection,
    onProgress: (cloakStage) => {
      // Map Cloak's internal progress to our coarser stage enum so the
      // UI's progress bar tracks something sensible.
      if (cloakStage.stage === 'depositing') onProgress?.('cloak_deposit');
      else if (cloakStage.stage === 'relay_withdraw') onProgress?.('cloak_withdraw');
      else if (cloakStage.stage === 'derive_keypair') onProgress?.('cloak_alt_setup');
    },
  });

  // Step 3: build fund_project tx with the funding ephemeral as funder
  // + the prepended Ed25519SigVerify ix proving buyer authorization.
  // Sign locally with the ephemeral keypair (no Phantom popup) and
  // submit. We need the milestone PDAs as remaining-accounts (same
  // pattern as the public award-fund flow).
  onProgress?.('sending_fund');
  const milestoneCount = input.milestoneAmounts.length;
  const milestonePdas: Address[] = [];
  for (let i = 0; i < milestoneCount; i++) {
    const [pda] = await findMilestonePda(rfpPda, i);
    milestonePdas.push(pda);
  }

  const fundEd25519Ix = buildEd25519SigVerifyIx({
    pubkey: buyer,
    signature: fundAuthSignature,
    message: fundAuthMessage,
  });

  const ephemeralSigner: TransactionSigner = createNoopSigner(
    fundingEphemeral.publicKey.toBase58() as Address,
  );
  const fundIx = await instructions.getFundProjectInstructionAsync({
    funder: ephemeralSigner,
    buyer: buyer,
    rfp: rfpPda,
    mint,
  });
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

  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const txBytes = encodeTx(
    [setComputeUnitLimitIx(1_400_000), fundEd25519Ix, fundIxWithExtras],
    fundingEphemeral.publicKey.toBase58() as Address,
    blockhash,
  );

  // Sign locally with the ephemeral. We need a signed VersionedTransaction
  // since encodeTx produces v0 message bytes. Sign by reconstructing a
  // VersionedTransaction and adding the ephemeral's signature.
  const { VersionedTransaction } = await import('@solana/web3.js');
  const versionedTx = VersionedTransaction.deserialize(txBytes);
  versionedTx.sign([fundingEphemeral]);
  const signedBytes = versionedTx.serialize();

  const fundTxSignature = await sendSigned(signedBytes, rpc);
  await waitConfirmed(rpc, fundTxSignature);

  onProgress?.('done');
  return {
    fundTxSignature,
    cloakDepositSig: cloakResult.depositSig,
    cloakWithdrawSig: cloakResult.withdrawSig,
    fundingEphemeralAta: cloakResult.ephemeralAta.toBase58(),
  };
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

/* -------------------------------------------------------------------------- */
/* awardAndFundAsHdBuyer — one-click award+fund for HD-private buyers.        */
/*                                                                             */
/* Mirror of the public-buyer awardAndFund UX (one click → done) but routed   */
/* through the HD identity:                                                   */
/*                                                                             */
/*   1. (optional) reveal_reserve — signed locally by HD buyer ephemeral      */
/*   2. select_bid — signed locally by HD buyer ephemeral; fee paid by the    */
/*      ephemeral's own SOL (must have ~0.005 SOL, top-up if needed)          */
/*   3. fund_project — routed via Cloak shielded pool:                        */
/*        a. main wallet pays USDC into Cloak shielded pool (1 popup)         */
/*        b. relay-paid withdraw to HD funding ephemeral's USDC ATA           */
/*        c. funding ephemeral signs fund_project locally                      */
/*        d. Ed25519SigVerify ix prepended with HD buyer ephemeral's          */
/*           fund-auth signature                                              */
/*                                                                             */
/* Net popups for the user: 1 (Cloak deposit). Net time: ~90s end-to-end.    */
/* -------------------------------------------------------------------------- */

export interface AwardAndFundAsHdBuyerInput {
  /** HD buyer ephemeral pubkey — equals on-chain `rfp.buyer`. */
  buyer: Address;
  /** HD buyer ephemeral keypair — signs select_bid + reveal_reserve + the
   *  fund-auth message locally (no popups). Derived via
   *  `keychain.buyerEphemeral(hdIndex)`. */
  buyerEphemeralKeypair: import('@solana/web3.js').Keypair;
  rfpPda: Address;
  winnerBidPda: Address;
  /** v2 claim-based: equals the bid signer in both modes. Public bidder
   *  mode: main wallet. Private bidder mode: bidder ephemeral. The
   *  program records this on `rfp.winner_provider`; payouts land on its
   *  ATA. The provider's main wallet stays unlinked in private mode
   *  until they run attest_win after project completion. */
  winnerProviderWallet: Address;
  /** Same as winnerProviderWallet in v2 claim-based mode — kept as a
   *  distinct field so callers can highlight "bid signer" in UI copy. */
  bidSignerWallet: Address;
  contractValue: bigint;
  mint: Address;
  /** Reveal pieces if the buyer committed a reserve at create time. */
  reserveReveal?: { amount: bigint; nonceHex: string };
  milestoneAmounts: bigint[];
  milestoneDurationsSecs: bigint[];
  /** Connected wallet — pays Cloak deposit fees + ATA/ALT rent. */
  buyerWallet: Address;
  /** Wallet adapter signMessage (for Cloak's viewing-key registration). */
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Wallet adapter single-tx signTransaction (for Cloak deposit). */
  signTransaction: <
    T extends
      | import('@solana/web3.js').Transaction
      | import('@solana/web3.js').VersionedTransaction,
  >(
    tx: T,
  ) => Promise<T>;
  rpc: Rpc<SolanaRpcApi>;
  connection: import('@solana/web3.js').Connection;
  onProgress?: (s: AwardStage | PrivateFundStage) => void;
}

export interface AwardAndFundAsHdBuyerResult {
  revealTxSignature?: string;
  selectTxSignature: string;
  fundTxSignature: string;
  cloakDepositSig: string;
  cloakWithdrawSig: string;
}

export async function awardAndFundAsHdBuyer(
  input: AwardAndFundAsHdBuyerInput,
): Promise<AwardAndFundAsHdBuyerResult> {
  const {
    buyer,
    buyerEphemeralKeypair,
    rfpPda,
    winnerBidPda,
    winnerProviderWallet,
    bidSignerWallet,
    contractValue,
    mint,
    reserveReveal,
    milestoneAmounts,
    milestoneDurationsSecs,
    buyerWallet,
    signMessage,
    signTransaction,
    rpc,
    connection,
    onProgress,
  } = input;

  // Mirror the validation block from awardAndFund.
  const milestoneCount = milestoneAmounts.length;
  if (milestoneCount < 1 || milestoneCount > 8) {
    throw new Error(`milestoneAmounts must have 1–8 entries, got ${milestoneCount}.`);
  }
  if (milestoneAmounts.reduce((a, b) => a + b, 0n) !== contractValue) {
    throw new Error('milestoneAmounts must sum to exactly contractValue.');
  }
  if (milestoneDurationsSecs.length !== milestoneCount) {
    throw new Error('milestoneDurationsSecs length must equal milestoneAmounts length.');
  }

  // Pre-flight chain status — same idempotent-retry rule as the public
  // path: skip steps already past their on-chain gate.
  const currentRfp = await fetchRfp(rfpPda);
  if (!currentRfp) throw new Error(`awardAndFundAsHdBuyer: RFP ${rfpPda} not found.`);
  const currentStatus = rfpStatusToString(currentRfp.status);
  const needsSelect = currentStatus === 'reveal' || currentStatus === 'bidsclosed';
  const needsFund = currentStatus === 'awarded' || needsSelect;
  const needsReveal = needsSelect && !!reserveReveal;
  if (!needsFund) {
    throw new Error(
      `awardAndFundAsHdBuyer: RFP is in status '${currentStatus}', past the awardable window.`,
    );
  }

  // Use the buyer ephemeral as both fee payer + signer for select_bid /
  // reveal_reserve. It needs ~0.005 SOL on the ephemeral; that's funded
  // separately at create time + by the user via the ephemeral manager.
  const buyerEphAddr = buyerEphemeralKeypair.publicKey.toBase58() as Address;
  if (buyerEphAddr !== buyer) {
    throw new Error('awardAndFundAsHdBuyer: ephemeral keypair pubkey does not match `buyer` arg.');
  }
  const buyerSigner: TransactionSigner = createNoopSigner(buyer);
  // v2 claim-based — see awardAndFund comment above. No binding-sig
  // prepend at select_bid; provider claims into main rep later via
  // attest_win after project completion.
  void bidSignerWallet;

  const result: AwardAndFundAsHdBuyerResult = {
    selectTxSignature: '',
    fundTxSignature: '',
    cloakDepositSig: '',
    cloakWithdrawSig: '',
  };

  // 1. reveal_reserve (if needed) — local sign with buyer ephemeral.
  if (needsReveal) {
    onProgress?.('building_txs');
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const ix = instructions.getRevealReserveInstruction({
      buyer: buyerSigner,
      rfp: rfpPda,
      reserveAmount: reserveReveal!.amount,
      reserveNonce: hexToBytes(reserveReveal!.nonceHex),
    });
    const txBytes = encodeTx([ix], buyer, blockhash);
    onProgress?.('sending_reveal');
    const sig = await signAndSendLocal(txBytes, buyerEphemeralKeypair, rpc);
    await waitConfirmed(rpc, sig);
    result.revealTxSignature = sig;
  }

  // 2. select_bid — local sign with buyer ephemeral. Mirrors the public
  // path's tx shape (CU bump + optional bid-binding ed25519 verify).
  if (needsSelect) {
    onProgress?.('building_txs');
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const [providerRep] = await findProviderReputationPda(winnerProviderWallet);
    const selectIx = await instructions.getSelectBidInstructionAsync({
      buyer: buyerSigner,
      rfp: rfpPda,
      bid: winnerBidPda,
      winnerProvider: winnerProviderWallet,
      providerReputation: providerRep,
      contractValue,
      milestoneCount,
      milestoneAmounts,
      milestoneDurationsSecs,
    });
    const ixs = [setComputeUnitLimitIx(1_400_000), selectIx];
    const txBytes = encodeTx(ixs, buyer, blockhash);
    onProgress?.('sending_select');
    const sig = await signAndSendLocal(txBytes, buyerEphemeralKeypair, rpc);
    await waitConfirmed(rpc, sig);
    result.selectTxSignature = sig;
  }

  // 3a. SOL preflight on the buyer ephemeral. The next step (Cloak
  // bootstrap of the funder ephemeral's USDC ATA + ALT) is signed and
  // PAID by the buyer ephemeral so main wallet doesn't appear as the tx
  // fee payer on those rent-paying accounts. ATA + ALT cost roughly
  // 0.005 SOL combined; we set the floor at 0.012 SOL to leave slack
  // for downstream actions (close_bidding, milestone accept/reject etc.
  // all also signed by the buyer ephemeral). If short, route a small
  // Cloak SOL top-up first — adds one wallet popup but keeps the
  // ephemeral's funding source unlinkable to main on chain.
  const SOL_THRESHOLD_LAMPORTS = 12_000_000n;
  const SOL_TOPUP_LAMPORTS = 30_000_000n; // 0.03 SOL — covers threshold + headroom
  const balanceResp = await rpc.getBalance(buyer).send();
  const ephSolLamports = BigInt(balanceResp.value);
  if (ephSolLamports < SOL_THRESHOLD_LAMPORTS) {
    onProgress?.('topping_up_signer');
    const { fundEphemeralWallet } = await import('@/lib/sdks/cloak');
    const { PublicKey } = await import('@solana/web3.js');
    await fundEphemeralWallet({
      walletPublicKey: new PublicKey(buyerWallet),
      signTransaction,
      signMessage: async (msg: Uint8Array) => (await signMessage({ message: msg })).signature,
      ephemeralPubkey: buyerEphemeralKeypair.publicKey,
      depositLamports: SOL_TOPUP_LAMPORTS,
      connection,
    });
  }

  // 3b. fund_project via Cloak — main → shielded → ephemeral funder;
  // funder signs fund_project; Ed25519SigVerify uses HD buyer ephemeral's
  // fund-auth signature (signed locally — no popup). The bootstrap keypair
  // (= buyer ephemeral) signs+pays the funder's USDC ATA + Cloak ALT,
  // collapsing what was 4 wallet popups (ATA + ALT + signMessage +
  // deposit) down to 2 (signMessage + deposit). Main wallet still pays
  // the deposit — that's the unavoidable Cloak entry; everything else
  // routes through the ephemeral so the on-chain trail can't be hopped
  // back to main wallet via tx fee payer.
  // Funder = buyer-eph (unified). The on-chain `fund_project` ix verifies
  // an Ed25519SigVerify of `rfp.buyer`'s pubkey signing the fund-auth
  // message — when funder == buyer, that's the same keypair signing both
  // the tx and the auth message, which the program accepts (it has no
  // funder ≠ buyer requirement). Removing the separate funder-eph drops
  // one HKDF derivation, one ATA, and lets refunds + initial deposit
  // share the same buyer-eph USDC ATA. Recovery from a stuck fund
  // attempt is via the dashboard's Ephemeral Sweep on buyer-eph.
  const fundResult = await fundEscrowPrivately({
    buyer,
    rfpPda,
    contractValue,
    mint,
    milestoneAmounts,
    milestoneDurationsSecs,
    // Buyer ephemeral signs the fund-auth message locally — no popup.
    signFundAuth: async (message) => {
      // biome-ignore lint/suspicious/noExplicitAny: noble subpath types vary
      const ed = (await import('@noble/curves/ed25519.js')) as any;
      const ed25519 = ed.ed25519 ?? ed.default?.ed25519 ?? ed;
      const seed32 = buyerEphemeralKeypair.secretKey.slice(0, 32);
      return new Uint8Array(ed25519.sign(message, seed32));
    },
    signTransaction,
    signMessage,
    fundingEphemeral: buyerEphemeralKeypair,
    bootstrapKeypair: buyerEphemeralKeypair,
    buyerWallet,
    rpc,
    connection,
    onProgress,
  });
  result.fundTxSignature = fundResult.fundTxSignature;
  result.cloakDepositSig = fundResult.cloakDepositSig;
  result.cloakWithdrawSig = fundResult.cloakWithdrawSig;

  onProgress?.('done');
  return result;
}

async function signAndSendLocal(
  txBytes: Uint8Array,
  keypair: import('@solana/web3.js').Keypair,
  rpc: Rpc<SolanaRpcApi>,
): Promise<string> {
  const { VersionedTransaction } = await import('@solana/web3.js');
  const versionedTx = VersionedTransaction.deserialize(txBytes);
  versionedTx.sign([keypair]);
  return sendSigned(versionedTx.serialize(), rpc);
}
