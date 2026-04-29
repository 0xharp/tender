/**
 * RFP create payload schema — shared by the form (client) and the
 * /api/rfps POST handler (server).
 */
import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });

export const milestoneTemplateEntrySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  percentage: z.number().int().min(1).max(100),
});

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

export const rfpCreatePayloadSchema = z.object({
  on_chain_pda: z.string().min(32).max(44),
  rfp_nonce_hex: z.string().regex(/^[0-9a-f]{16}$/),
  buyer_encryption_pubkey_hex: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(3).max(200),
  category: z.enum(RFP_CATEGORIES),
  scope_summary: z.string().min(20).max(4000),
  budget_max_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  bid_open_at: isoDateTime,
  bid_close_at: isoDateTime,
  reveal_close_at: isoDateTime,
  milestone_template: z.array(milestoneTemplateEntrySchema).min(1).max(8),
  tx_signature: z.string().min(40).max(120),
});

export type RfpCreatePayload = z.infer<typeof rfpCreatePayloadSchema>;

export const rfpFormSchema = z.object({
  title: z.string().min(3, 'At least 3 characters').max(200),
  category: z.enum(RFP_CATEGORIES),
  scope_summary: z
    .string()
    .min(20, 'Scope must be at least 20 characters so providers know what to bid on')
    .max(4000),
  budget_max_usdc: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, 'Use digits only, optional cents (e.g. "45000" or "45000.50")'),
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
  milestone_count: z.number().int().min(1).max(8),
});

export type RfpFormValues = z.infer<typeof rfpFormSchema>;
