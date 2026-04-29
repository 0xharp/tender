/**
 * Bid POST payload schema — shared between BidComposer client and /api/bids.
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

export const bidPostPayloadSchema = z.object({
  rfp_id: z.string().uuid(),
  rfp_pda: z.string().min(32).max(44),
  on_chain_pda: z.string().min(32).max(44),
  // Buyer-decryptable ciphertext. The on-chain commit_hash refers to this.
  ephemeral_pubkey_hex: z.string().regex(/^[0-9a-f]{64}$/),
  commit_hash_hex: z.string().regex(/^[0-9a-f]{64}$/),
  ciphertext_base64: z.string().min(20),
  // Provider-decryptable ciphertext (encrypted to provider's wallet-derived
  // X25519 pubkey). Same plaintext, second ECIES envelope.
  provider_ephemeral_pubkey_hex: z.string().regex(/^[0-9a-f]{64}$/),
  provider_ciphertext_base64: z.string().min(20),
  storage_backend: z.enum(['supabase', 'ipfs', 'arweave', 'per']).default('supabase'),
  per_session_id: z.string().nullable().optional(),
});

export type BidPostPayload = z.infer<typeof bidPostPayloadSchema>;

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
