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

export const bidderVisibilitySchema = z.enum(['public', 'buyer_only']);
export type BidderVisibility = z.infer<typeof bidderVisibilitySchema>;

/**
 * Off-chain metadata payload (post-shrink). Everything else (windows, status,
 * buyer pubkey, category, visibility, etc.) lives on the on-chain Rfp account
 * at `on_chain_pda` - clients enrich there. `rfp_nonce_hex` is kept off-chain
 * because the on-chain Rfp account doesn't store it (only the PDA seed binds
 * it) and providers need the exact bytes to derive PDAs.
 */
export const rfpCreatePayloadSchema = z.object({
  on_chain_pda: z.string().min(32).max(44),
  rfp_nonce_hex: z.string().regex(/^[0-9a-f]{16}$/),
  title: z.string().min(3).max(200),
  scope_summary: z.string().min(20).max(4000),
  tx_signature: z.string().min(40).max(120),
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
  bid_window_hours: z
    .number()
    .int()
    .min(1, 'At least 1 hour')
    .max(24 * 14, 'At most 14 days'),
  reveal_window_hours: z
    .number()
    .int()
    .min(1, 'At least 1 hour')
    .max(24 * 14, 'At most 14 days'),
  bidder_visibility: bidderVisibilitySchema.default('public'),
});

export type RfpFormValues = z.infer<typeof rfpFormSchema>;
