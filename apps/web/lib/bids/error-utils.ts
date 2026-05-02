/**
 * User-friendly error messages for failures coming back from on-chain txs and
 * the bid submit/withdraw flow.
 *
 * Anchor errors come through as `{"InstructionError":[ix_index, {"Custom": code}]}`.
 * The code matches one of our `TenderError` enum variants. We map the numeric
 * code to a short, human-readable message - better than dumping JSON in a toast.
 *
 * Non-Anchor errors (delegation program seeds violations, system-program
 * errors, etc.) pass through with a tighter prefix.
 */

// Mirror of the TenderError enum in `programs/tender/src/errors.rs`.
// **MUST match the Rust enum order** - Anchor auto-numbers from 6000 by
// declaration order. Adding/removing a variant in the middle of the Rust
// enum shifts every code below it, so re-sync this list whenever you touch
// `errors.rs`.
const TENDER_ERROR_BASE = 6000;
const TENDER_ERROR_NAMES: readonly { code: number; name: string; message: string }[] = [
  // Time-window errors (6000–6010)
  { code: 6000, name: 'BidWindowNotOpen', message: 'The bid window for this RFP hasn’t opened yet.' },
  { code: 6001, name: 'BidWindowClosed', message: 'The bid window has closed - this action isn’t allowed anymore.' },
  { code: 6002, name: 'BidWindowStillOpen', message: 'Wait for the bid window to close before doing this.' },
  { code: 6003, name: 'RevealWindowExpired', message: 'The reveal window has expired - the buyer missed the award deadline.' },
  { code: 6004, name: 'FundingWindowExpired', message: 'The funding window has expired - the buyer can be marked as ghosted.' },
  { code: 6005, name: 'FundingWindowOpen', message: 'The funding window is still open - give the buyer time to fund.' },
  { code: 6006, name: 'ReviewWindowOpen', message: 'The buyer’s review window is still open.' },
  { code: 6007, name: 'ReviewWindowExpired', message: 'The buyer’s review window has expired.' },
  { code: 6008, name: 'CancelNoticeActive', message: 'Cancel-with-notice period is still in effect.' },
  { code: 6009, name: 'DisputeCooloffActive', message: 'Dispute cool-off is still active.' },
  { code: 6010, name: 'DisputeCooloffExpired', message: 'Dispute cool-off has expired - the default 50/50 split applies.' },
  // Bid lifecycle (6011–6014)
  { code: 6011, name: 'BidAlreadyCommitted', message: 'A bid already exists for this provider. Withdraw it first to submit a new one.' },
  { code: 6012, name: 'BidCommitHashMismatch', message: 'Bid commit hash mismatch - the chunks you wrote don’t match the declared hash.' },
  { code: 6013, name: 'BidNotWithdrawable', message: 'This bid can’t be withdrawn (already selected, withdrawn, or past the bid window).' },
  { code: 6014, name: 'InvalidBidStatus', message: 'Bid is in the wrong state for this action.' },
  // Authorization (6015–6019)
  { code: 6015, name: 'NotBuyer', message: 'Only the RFP’s buyer can do this.' },
  { code: 6016, name: 'NotProvider', message: 'Your wallet doesn’t match the bid’s provider - try connecting the wallet you used to submit it.' },
  { code: 6017, name: 'NotDisputeParty', message: 'Only the buyer or the winning provider can act on this dispute.' },
  { code: 6018, name: 'NotTreasuryAuthority', message: 'Only the treasury authority can do this.' },
  { code: 6019, name: 'InvalidAttestation', message: 'Binding signature verification failed - the Ed25519SigVerify ix doesn’t match the expected main-wallet binding for this private bid. Re-derive the bid signature and try again.' },
  // Input validation (6020–6035)
  { code: 6020, name: 'InvalidMilestoneCount', message: 'Milestone count must be between 1 and 8.' },
  { code: 6021, name: 'InvalidMilestonePercentages', message: 'Milestone amounts don’t match the contract value, or one of them is zero.' },
  { code: 6022, name: 'InvalidMilestoneIndex', message: 'Milestone index out of bounds.' },
  { code: 6023, name: 'InvalidBidWindow', message: 'Time windows must satisfy bid_open < bid_close < reveal_close.' },
  { code: 6024, name: 'InvalidWindowSecs', message: 'Each per-RFP window must be a positive duration.' },
  { code: 6025, name: 'InvalidMaxIterations', message: 'max_iterations must be at least 1.' },
  { code: 6026, name: 'ReserveCommitmentMismatch', message: 'Reserve commitment doesn’t match the revealed amount + nonce.' },
  { code: 6027, name: 'WinningBidExceedsReserve', message: 'The winning bid exceeds the revealed reserve price - pick a different bid.' },
  { code: 6028, name: 'DeclaredAmountMismatch', message: 'Declared winning amount doesn’t match the bid envelope.' },
  { code: 6029, name: 'CrossChainNotYetSupported', message: 'Provider declared a payout chain that V1 doesn’t yet support.' },
  { code: 6030, name: 'EnvelopeTooLarge', message: 'Bid envelope exceeds the maximum size.' },
  { code: 6031, name: 'EnvelopeEmpty', message: 'Envelope sizes must be > 0.' },
  { code: 6032, name: 'InvalidSplit', message: 'Dispute split must be in 0..=10000 basis points.' },
  { code: 6033, name: 'SplitMismatch', message: 'Both parties must propose the same dispute split.' },
  { code: 6034, name: 'IterationsExhausted', message: 'Provider has used all iteration retries for this milestone.' },
  { code: 6035, name: 'InvalidFeeBps', message: 'Platform fee bps must be ≤ 10000.' },
  // Chunked write (6036–6038)
  { code: 6036, name: 'ChunkOffsetOutOfBounds', message: 'Chunk offset is out of bounds for the declared envelope size.' },
  { code: 6037, name: 'ChunkOverrun', message: 'Chunk would write past the declared envelope size.' },
  { code: 6038, name: 'InvalidEnvelopeKind', message: 'Chunk targets an unknown envelope kind (must be 0 = buyer, 1 = provider).' },
  // Status transitions (6039–6043)
  { code: 6039, name: 'InvalidRfpStatus', message: 'RFP isn’t in a state that allows this action.' },
  { code: 6040, name: 'InvalidMilestoneStatus', message: 'Milestone is not in the expected state for this action.' },
  { code: 6041, name: 'AnotherMilestoneActive', message: 'Another milestone is currently active - only one can be in flight at a time. Submit it first.' },
  { code: 6042, name: 'DeliveryDeadlineNotPassed', message: 'Delivery deadline hasn’t passed yet - use cancel-with-penalty instead.' },
  { code: 6043, name: 'NoDeliveryDeadline', message: 'This milestone has no delivery deadline - cancel-late-milestone isn’t available.' },
  // Escrow math (6044–6045)
  { code: 6044, name: 'MathOverflow', message: 'Token math overflow.' },
  { code: 6045, name: 'InsufficientEscrow', message: 'Insufficient escrow balance.' },
];

const TENDER_ERROR_BY_CODE = new Map(TENDER_ERROR_NAMES.map((e) => [e.code, e]));

// Anchor's framework errors (2000–2999 range)
const ANCHOR_FRAMEWORK_ERRORS: Record<number, string> = {
  2006: 'Account seeds did not derive a valid PDA - likely a client/program version mismatch.',
  2003: 'A constraint was violated.',
  2502: 'A required account is missing from the transaction.',
};

const TX_FAILED_PREFIX = /^tx [^ ]+ failed:\s*/;

/**
 * Convert a thrown Error from the bid flow into a user-readable string.
 * Recognizes:
 *   - `tx <sig> failed: {"InstructionError":[N, {"Custom": code}]}` (our flows)
 *   - Plain JSON tx-error payloads
 *   - Wallet rejections / abort errors
 *   - Anything else passes through.
 */
export function friendlyBidError(err: unknown): string {
  if (!err) return 'Unknown error';
  const message = err instanceof Error ? err.message : String(err);

  // Strip our `tx <sig> failed: ` prefix if present so we get to the JSON payload.
  const stripped = message.replace(TX_FAILED_PREFIX, '');

  // Try parse the JSON payload - could be the whole message or embedded.
  let payload: unknown = null;
  try {
    payload = JSON.parse(stripped);
  } catch {
    // not JSON - handle as plain text below
  }

  if (payload && typeof payload === 'object') {
    const friendly = describeTxError(payload);
    if (friendly) return friendly;
  }

  // Common wallet-side / RPC error patterns
  if (/User rejected|denied|cancell?ed/i.test(message)) {
    return 'Approval cancelled in the wallet.';
  }
  if (/insufficient funds/i.test(message)) {
    return 'Insufficient SOL on the signer wallet.';
  }
  if (/timed out/i.test(message)) {
    return 'Timed out waiting for the transaction to confirm. Check Solscan for the signature.';
  }

  return message;
}

/**
 * Walk a parsed TransactionError shape looking for a `Custom: <code>` we
 * recognize. Solana sends `InstructionError: [u8, error]` where the inner
 * error can be `{Custom: u32}` or a string variant.
 */
function describeTxError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;

  // {InstructionError: [ix_index, {Custom: code}]} or [ix_index, "VariantName"]
  const ixErr = (payload as Record<string, unknown>).InstructionError;
  if (Array.isArray(ixErr) && ixErr.length === 2) {
    const ixIndex = ixErr[0];
    const inner = ixErr[1];
    if (typeof inner === 'object' && inner !== null) {
      const customCode = (inner as Record<string, unknown>).Custom;
      const code = typeof customCode === 'string' ? Number(customCode) : (customCode as number);
      if (typeof code === 'number' && Number.isFinite(code)) {
        const tender = TENDER_ERROR_BY_CODE.get(code);
        if (tender) {
          return `${tender.name} - ${tender.message}`;
        }
        const anchor = ANCHOR_FRAMEWORK_ERRORS[code];
        if (anchor) {
          return `${anchor} (Anchor #${code}, ix ${ixIndex})`;
        }
        return `On-chain error #${code} at instruction ${ixIndex}.`;
      }
    } else if (typeof inner === 'string') {
      return `Instruction ${ixIndex}: ${inner.replace(/([A-Z])/g, ' $1').trim()}`;
    }
  }

  return null;
}

/**
 * Re-export of the underlying constant base so callers can sanity-check
 * codes against the Tender range.
 */
export const TENDER_ERROR_RANGE = {
  base: TENDER_ERROR_BASE,
  max: TENDER_ERROR_BASE + TENDER_ERROR_NAMES.length - 1,
};

/**
 * Convert a snake_case stage label into a friendly "Sentence case…" suffix
 * suitable for showing inside a disabled button. Falls back to a static
 * label when no stage is set yet. Useful for keeping button text consistent
 * regardless of which orchestrator emits which stage names.
 *
 * Examples:
 *   humanizeStage('authenticating_er')     → "Authenticating er…"
 *   humanizeStage('awaiting_seal_back')    → "Awaiting seal back…"
 *   humanizeStage(null, 'Withdrawing')     → "Withdrawing…"
 */
export function humanizeStage(stage: string | null | undefined, fallback = 'Working'): string {
  if (!stage) return `${fallback}…`;
  // Allow callers to pass already-humanized strings - only transform
  // snake_case-looking inputs.
  const looksSnake = /^[a-z][a-z0-9_]*$/.test(stage);
  if (!looksSnake) return stage.endsWith('…') ? stage : `${stage}…`;
  const spaced = stage.replace(/_/g, ' ');
  const sentence = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return `${sentence}…`;
}
