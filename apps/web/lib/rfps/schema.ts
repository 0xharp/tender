/**
 * RFP create payload schema - shared by the form (client) and the
 * /api/rfps POST handler (server).
 *
 * Milestones intentionally absent: RFPs describe scope, bids carry the
 * milestone breakdown. The on-chain Rfp account stores `milestone_count = 0`
 * + `milestone_percentages = [0; 8]` until a winner is selected, at which
 * point `select_bid` writes the winning bid's structure to the rfp.
 */
import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });

export const RFP_CATEGORIES = [
  'audit',
  'design',
  'engineering',
  'legal',
  'marketing',
  'market_making',
  'other',
] as const;
export type RfpCategoryEnum = (typeof RFP_CATEGORIES)[number];

export const bidderVisibilitySchema = z.enum(['public', 'buyer_only'], {
  // Friendly fallback shown when the form is submitted without a radio
  // selected. Without this override, zod surfaces the raw enum names
  // (`Invalid option: expected one of "public"|"buyer_only"`) which
  // leak internal vocabulary and read like a stack trace.
  message: 'Pick a bidder privacy mode to continue.',
});
export type BidderVisibility = z.infer<typeof bidderVisibilitySchema>;

/** v2: orthogonal to bidder visibility. Controls whether the buyer's
 *  main wallet is observably linked to this RFP on chain.
 *  - 'public':  rfp.buyer = main wallet (today's behavior)
 *  - 'private': rfp.buyer = HD-derived ephemeral; main wallet hidden,
 *               buyer rep doesn't accumulate unless attest_buyer_history
 *               is called post-completion. */
export const buyerVisibilitySchema = z.enum(['public', 'private'], {
  message: 'Pick a buyer privacy mode to continue.',
});
export type BuyerVisibility = z.infer<typeof buyerVisibilitySchema>;

/**
 * Off-chain metadata payload (post-shrink). Everything else (windows, status,
 * buyer pubkey, category, visibility, etc.) lives on the on-chain Rfp account
 * at `on_chain_pda` - clients enrich there. `rfp_nonce_hex` is kept off-chain
 * because the on-chain Rfp account doesn't store it (only the PDA seed binds
 * it) and providers need the exact bytes to derive PDAs.
 */
/**
 * v2: optional ephemeral self-signed auth. When present, /api/rfps
 * verifies the signature against `rfp.buyer` on chain instead of
 * requiring a SIWS session cookie. Used by the private-create flow so
 * supabase audit logs only reference the ephemeral pubkey, not the
 * buyer's main wallet (which would otherwise correlate via the SIWS
 * session to the rfp_pda).
 *
 * The canonical message format (newline-delimited, deterministic):
 *
 *     tender-metadata-pin-v1
 *     program=<base58 program id>
 *     rfp=<base58 rfp pda>
 *     title_hash=<hex sha256(title)>
 *     issued_at=<iso8601>
 *
 * Server verifies:
 *  1. Message parses + has the right format prefix
 *  2. `rfp` field matches on_chain_pda in the body
 *  3. `title_hash` matches sha256(body.title) byte-for-byte
 *  4. `issued_at` is within ±5 minutes of server clock
 *  5. ed25519 signature is valid against the pubkey we read from
 *     `rfp.buyer` on chain — only that ephemeral can pin metadata
 */
export const ephemeralAuthSchema = z.object({
  message: z.string().min(80).max(400),
  /** Base64-encoded 64-byte ed25519 signature. */
  signature: z.string().regex(/^[A-Za-z0-9+/]+=*$/),
});

export type EphemeralAuth = z.infer<typeof ephemeralAuthSchema>;

export const rfpCreatePayloadSchema = z.object({
  on_chain_pda: z.string().min(32).max(44),
  rfp_nonce_hex: z.string().regex(/^[0-9a-f]{16}$/),
  title: z.string().min(3).max(200),
  scope_summary: z.string().min(20).max(4000),
  tx_signature: z.string().min(40).max(120),
  /** v2: ephemeral self-signed auth for private-buyer RFPs. When
   *  present, the server-side validator falls into the ephemeral-auth
   *  branch and skips the SIWS-session check. */
  ephemeral_auth: ephemeralAuthSchema.optional(),
});

export type RfpCreatePayload = z.infer<typeof rfpCreatePayloadSchema>;

void isoDateTime; // kept as a re-export hook for future encrypted-scope flows
void RFP_CATEGORIES; // ditto - category lives on-chain but we keep the enum for UI

export const rfpFormSchema = z.object({
  title: z.string().min(3, 'At least 3 characters').max(200),
  category: z.enum(RFP_CATEGORIES),
  scope_summary: z
    .string()
    .min(20, 'Scope must be at least 20 characters so providers know what to bid on')
    .max(4000),
  /** Optional sealed reserve. Empty = no reserve enforcement. */
  reserve_price_usdc: z
    .string()
    .regex(/^(\d+(\.\d{1,6})?)?$/, 'Use digits only, optional cents (e.g. "45000" or "45000.50")')
    .optional()
    .default(''),
  // Fractional hours allowed (down to 0.5 = 30 min) so a buyer running
  // a fast-turnaround procurement (live bidding window during a meeting,
  // crisis-response RFP, etc.) doesn't have to wait an extra hour just
  // to satisfy a stale schema constraint. Chain stores a unix timestamp
  // so any positive duration works mechanically; the floor is purely a
  // UX guard against accidentally typing 0.
  bid_window_hours: z
    .number()
    .min(0.5, 'At least 0.5 hours (30 min)')
    .max(24 * 14, 'At most 14 days'),
  reveal_window_hours: z
    .number()
    .min(0.5, 'At least 0.5 hours (30 min)')
    .max(24 * 14, 'At most 14 days'),
  // No `.default()` on either visibility — we deliberately force the
  // user to make an explicit choice between public/private on both
  // axes. Otherwise the form silently locks them into the "public"
  // path without surfacing the privacy mode toggle.
  bidder_visibility: bidderVisibilitySchema,
  buyer_visibility: buyerVisibilitySchema,
});

export type RfpFormValues = z.infer<typeof rfpFormSchema>;
