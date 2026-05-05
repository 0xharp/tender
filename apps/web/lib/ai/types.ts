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
