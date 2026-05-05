/**
 * Type definitions + parsers for tendr's AI responses.
 *
 * Both `draftRfpScope` and `draftBid` return raw markdown strings —
 * no parsing, the buyer / provider just pastes them into the form
 * field. `compareBids` returns structured JSON (per the prompt
 * contract); we validate via Zod and gracefully fall back to "raw
 * text" rendering if the model went off-format.
 */
import { z } from 'zod';

// ─── compareBids JSON schema ─────────────────────────────────────────────────

export const bidComparisonRowSchema = z.object({
  bidIndex: z.number().int(),
  priceUsdc: z.string(),
  timelineDays: z.number().int(),
  milestoneCount: z.number().int(),
  scopeCoverage: z.string(),
  milestoneRealism: z.string(),
  riskFlags: z.array(z.string()),
});

export const bidComparisonRecommendationSchema = z.object({
  bidIndex: z.number().int(),
  reasoning: z.string(),
});

export const bidComparisonSchema = z.object({
  rows: z.array(bidComparisonRowSchema),
  recommendation: bidComparisonRecommendationSchema,
});

export type BidComparisonRow = z.infer<typeof bidComparisonRowSchema>;
export type BidComparisonRecommendation = z.infer<typeof bidComparisonRecommendationSchema>;
export type BidComparison = z.infer<typeof bidComparisonSchema>;

/**
 * Parse a raw model response into a structured BidComparison. The model
 * is instructed to output ONLY JSON, but Qwen 7B Q4 occasionally adds a
 * preamble ("Here is the comparison:") or wraps in markdown fences. We
 * extract the first balanced { ... } substring before parsing.
 *
 * Returns null if the response can't be coerced into the schema —
 * caller should fall back to displaying the raw markdown.
 */
export function parseBidComparison(raw: string): BidComparison | null {
  // Try direct parse first.
  const direct = tryParse(raw);
  if (direct) return direct;
  // Try stripping markdown code fences.
  const fenceStripped = raw.replace(/```(?:json)?\n?|\n?```/g, '').trim();
  const fromFence = tryParse(fenceStripped);
  if (fromFence) return fromFence;
  // Last resort: extract the first balanced { ... } substring.
  const match = extractFirstJsonObject(raw);
  if (match) {
    const fromExtract = tryParse(match);
    if (fromExtract) return fromExtract;
  }
  return null;
}

function tryParse(s: string): BidComparison | null {
  try {
    const parsed = JSON.parse(s);
    const validated = bidComparisonSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

/** Greedy scan for the first balanced { ... }. Brace-depth tracking
 *  so nested objects don't false-stop. Doesn't try to be clever about
 *  strings containing braces; for our use case (Qwen output ≈ valid
 *  JSON) the simpler approach is fine. */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// ─── draftBid JSON schema ────────────────────────────────────────────────────
//
// Bid drafting now returns structured JSON so the modal can populate every
// field of the bid form (price, timeline, scope markdown, milestones array)
// instead of dropping a markdown blob into just the scope textarea. The
// schema is a SUBSET of the bid composer's own form fields — we deliberately
// keep field names + bounds in sync so the AI's output is drop-in compatible:
//
//   priceUsdc           ← form `price_usdc`           (regex: digits + optional cents)
//   timelineDays        ← form `timeline_days`        (1-365)
//   scope               ← form `scope`                (20-8000 chars, markdown ok)
//   milestones[].name           ← form milestones[].name           (1-120)
//   milestones[].description    ← form milestones[].description    (1-2000)
//   milestones[].amountUsdc     ← form milestones[].amount_usdc    (regex)
//   milestones[].durationDays   ← form milestones[].duration_days  (0-365)
//   milestones[].successCriteria← form milestones[].success_criteria (≤1000)
//
// If the AI drifts off-schema we fall back to `kind: 'raw'` (raw text in the
// modal preview, user copies/pastes manually). Same pattern as bid comparison.

export const bidDraftMilestoneSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  // Accept number or string — Qwen sometimes emits unquoted numerics for
  // the amount; we coerce to canonical string downstream.
  amountUsdc: z.union([z.string(), z.number()]).transform((v) => String(v)),
  durationDays: z.number().int().min(0).max(365),
  successCriteria: z.string().max(1000).optional(),
});

export const bidDraftSchema = z.object({
  priceUsdc: z.union([z.string(), z.number()]).transform((v) => String(v)),
  timelineDays: z.number().int().min(1).max(365),
  scope: z.string().min(20).max(8000),
  milestones: z.array(bidDraftMilestoneSchema).min(1).max(8),
  /** Optional — short bullet-style flags surfaced in the modal preview
   *  but never written into the form. Provider can read and decide. */
  riskFlags: z.array(z.string()).optional().default([]),
});

export type BidDraftMilestone = z.infer<typeof bidDraftMilestoneSchema>;
export type BidDraft = z.infer<typeof bidDraftSchema>;

/**
 * Same tolerant-parse pattern as `parseBidComparison` — direct, then
 * fence-stripped, then balanced-object extraction. Returns null if the
 * response can't be coerced into the schema.
 */
export function parseBidDraft(raw: string): BidDraft | null {
  const direct = tryParseBidDraft(raw);
  if (direct) return direct;
  const fenceStripped = raw.replace(/```(?:json)?\n?|\n?```/g, '').trim();
  const fromFence = tryParseBidDraft(fenceStripped);
  if (fromFence) return fromFence;
  const match = extractFirstJsonObject(raw);
  if (match) {
    const fromExtract = tryParseBidDraft(match);
    if (fromExtract) return fromExtract;
  }
  return null;
}

function tryParseBidDraft(s: string): BidDraft | null {
  try {
    const parsed = JSON.parse(s);
    const validated = bidDraftSchema.safeParse(parsed);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}
