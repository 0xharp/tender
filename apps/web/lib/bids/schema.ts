/**
 * Bid form + plaintext schemas. Used by `BidComposer` client and the
 * provider-side decryption flow.
 *
 * Day 6.5 update: bids are stored ENTIRELY on-chain (BidCommit account
 * delegated to MagicBlock PER). The `BidPostPayload` shape and
 * `bid_ciphertexts` table were removed in migration 0006 - there is no
 * off-chain bid row anymore.
 */
import { z } from 'zod';

export const sealedBidPlaintextSchema = z.object({
  priceUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  scope: z.string().min(20).max(8000),
  timelineDays: z.number().int().min(1).max(365),
  milestones: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        description: z.string().min(1).max(2000),
        amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
        /** Days the provider commits to deliver this milestone after Start.
         *  0 = provider declines a deadline (cancel-late-milestone disabled
         *  for this milestone). Sum of durations should typically equal
         *  `timelineDays`. */
        durationDays: z.number().int().min(0).max(365),
        /** Optional success criteria / KPI for this milestone. Free-text the
         *  provider commits to in their bid. Surfaces in the milestone row
         *  for both parties + referenced inline in dispute UI. Encrypted
         *  along with the rest of the bid envelope - same privacy guarantees
         *  as scope/price. Optional (no default) so the plaintext schema's
         *  input/output shapes line up; consumers should treat absence as
         *  "provider declined to set one." */
        successCriteria: z.string().max(1000).optional(),
      }),
    )
    .min(1)
    .max(8),
  payoutPreference: z.object({
    chain: z.literal('solana'),
    asset: z.literal('USDC'),
    address: z.string().min(32).max(44),
  }),
  notes: z.string().max(2000).optional(),
});

export type SealedBidPlaintext = z.infer<typeof sealedBidPlaintextSchema>;

export const bidderVisibilitySchema = z.enum(['public', 'buyer_only']);
export type BidderVisibility = z.infer<typeof bidderVisibilitySchema>;

export const bidFormSchema = z
  .object({
    price_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/, 'e.g. "45000" or "45000.50"'),
    scope: z.string().min(20).max(8000),
    timeline_days: z.number().int().min(1).max(365),
    milestones: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          description: z.string().min(1).max(2000),
          amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
          duration_days: z.number().int().min(0).max(365),
          /** What the provider commits this milestone will deliver - the
           *  acceptance bar. Optional; useful inline in dispute UI when
           *  buyer + provider disagree on whether a milestone met spec.
           *  Stored as plain optional (no default) to keep zod input/output
           *  shapes aligned for react-hook-form's Resolver. */
          success_criteria: z.string().max(1000).optional(),
        }),
      )
      .min(1)
      .max(8),
    payout_address: z.string().min(32).max(44),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((values, ctx) => {
    // Cross-field check: milestone amounts must sum to bid price (within rounding tolerance).
    const sum = values.milestones.reduce((acc, m) => acc + Number(m.amount_usdc || 0), 0);
    const price = Number(values.price_usdc || 0);
    const diff = Math.abs(sum - price);
    if (diff > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['milestones'],
        message: `Milestone amounts sum to ${sum.toFixed(2)} but bid price is ${price.toFixed(
          2,
        )}. They must match.`,
      });
    }
  });

export type BidFormValues = z.infer<typeof bidFormSchema>;
