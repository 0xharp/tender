/**
 * User-friendly error messages for failures coming back from on-chain txs and
 * the bid submit/withdraw flow.
 *
 * Anchor errors come through as `{"InstructionError":[ix_index, {"Custom": code}]}`.
 * The code matches one of our `TenderError` enum variants. We map the numeric
 * code to a short, human-readable message — better than dumping JSON in a toast.
 *
 * Non-Anchor errors (delegation program seeds violations, system-program
 * errors, etc.) pass through with a tighter prefix.
 */

// Mirror of the TenderError enum in `programs/tender/src/errors.rs`.
// Keep in sync when adding new error variants. The codama-generated
// `tenderErrorMessages` map is dev-only; this is our production-safe copy.
const TENDER_ERROR_BASE = 6000;
const TENDER_ERROR_NAMES: readonly { code: number; name: string; message: string }[] = [
  { code: 6000, name: 'BidWindowNotOpen', message: 'The bid window for this RFP hasn’t opened yet.' },
  { code: 6001, name: 'BidWindowClosed', message: 'The bid window has closed — this action isn’t allowed anymore.' },
  { code: 6002, name: 'BidWindowStillOpen', message: 'Wait for the bid window to close before doing this.' },
  { code: 6003, name: 'RevealWindowExpired', message: 'The reveal window has expired.' },
  { code: 6004, name: 'BidAlreadyCommitted', message: 'You already have a bid on this RFP. Withdraw it first to submit a new one.' },
  { code: 6005, name: 'BidCommitHashMismatch', message: 'Bid commit hash mismatch — the chunks you wrote don’t match the declared hash.' },
  { code: 6006, name: 'BidNotWithdrawable', message: 'This bid can’t be withdrawn (already selected, withdrawn, or past the bid window).' },
  { code: 6007, name: 'InvalidBidStatus', message: 'Bid is in the wrong state for this action.' },
  { code: 6008, name: 'NotBuyer', message: 'Only the RFP’s buyer can do this.' },
  { code: 6009, name: 'NotProvider', message: 'Your wallet doesn’t match the bid’s provider — try connecting the wallet you used to submit it.' },
  { code: 6010, name: 'InvalidMilestoneCount', message: 'Milestone count must be between 1 and 8.' },
  { code: 6011, name: 'InvalidBidWindow', message: 'Time windows must satisfy bid_open < bid_close < reveal_close.' },
  { code: 6012, name: 'UriTooLong', message: 'Ciphertext storage URI exceeds maximum length.' },
  { code: 6013, name: 'InvalidBudget', message: 'Budget must be greater than zero.' },
  { code: 6014, name: 'EnvelopeTooLarge', message: 'Bid envelope is too large.' },
  { code: 6015, name: 'EnvelopeEmpty', message: 'Envelope sizes must be > 0.' },
  { code: 6016, name: 'InvalidBidSeedForPublicMode', message: 'In Public mode, the bid PDA seed must equal your wallet bytes.' },
  { code: 6017, name: 'ChunkOffsetOutOfBounds', message: 'Chunk offset is out of bounds for the declared envelope size.' },
  { code: 6018, name: 'ChunkOverrun', message: 'Chunk would write past the declared envelope size.' },
  { code: 6019, name: 'InvalidEnvelopeKind', message: 'Chunk targets an unknown envelope kind (must be 0 = buyer, 1 = provider).' },
  { code: 6020, name: 'InvalidRfpStatus', message: 'RFP isn’t in a state that allows this action (e.g. you tried to bid on a closed RFP).' },
];

const TENDER_ERROR_BY_CODE = new Map(TENDER_ERROR_NAMES.map((e) => [e.code, e]));

// Anchor's framework errors (2000–2999 range)
const ANCHOR_FRAMEWORK_ERRORS: Record<number, string> = {
  2006: 'Account seeds did not derive a valid PDA — likely a client/program version mismatch.',
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

  // Try parse the JSON payload — could be the whole message or embedded.
  let payload: unknown = null;
  try {
    payload = JSON.parse(stripped);
  } catch {
    // not JSON — handle as plain text below
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
          return `${tender.name} — ${tender.message}`;
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
