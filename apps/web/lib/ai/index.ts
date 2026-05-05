'use client';

/**
 * Tendr AI surface orchestrators. Three load-bearing tasks:
 *
 *   1. `draftRfpScope(...)` — buyer types a paragraph, returns markdown
 *      scope summary (drop-into-textarea).
 *   2. `compareBids(...)` — buyer hands in RFP scope + decrypted bids,
 *      returns parsed `BidComparison` (or `{ raw }` fallback if the
 *      model went off-format).
 *   3. `draftBid(...)` — provider hands in RFP scope, returns markdown
 *      starting-point bid (drop-into-textarea).
 *
 * Each function:
 *   - Validates the AI sidecar is configured (returns `{ available:
 *     false }` if not — callers should hide the AI button).
 *   - Builds the messages from the prompt module.
 *   - Calls the QVAC sidecar via the OpenAI SDK.
 *   - Returns a typed shape the UI can render directly.
 *
 * Browser-only — these never touch Tendr's Next.js server.
 */

import { DEFAULT_GEN_PARAMS, TENDR_MODEL_ALIAS, getQvacClient, isAiAvailable } from './client';
import {
  BID_COMPARISON_SYSTEM_PROMPT,
  BID_DRAFT_SYSTEM_PROMPT,
  RFP_SCOPE_SYSTEM_PROMPT,
  buildBidComparisonUserPrompt,
  buildBidDraftUserPrompt,
  buildRfpScopeUserPrompt,
} from './prompts';
import { type BidComparison, parseBidComparison } from './types';

export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const NOT_CONFIGURED_REASON =
  'AI is not configured for this app. Set NEXT_PUBLIC_QVAC_BASE_URL to enable AI features.';

// ─── 1. RFP scope drafting ───────────────────────────────────────────────────

export async function draftRfpScope(args: {
  description: string;
  category?: string;
  budgetUsdc?: string;
  timelineDays?: number;
}): Promise<AiResult<string>> {
  const client = getQvacClient();
  if (!client) return { ok: false, reason: NOT_CONFIGURED_REASON };
  try {
    const completion = await client.chat.completions.create({
      model: TENDR_MODEL_ALIAS,
      ...DEFAULT_GEN_PARAMS,
      messages: [
        { role: 'system', content: RFP_SCOPE_SYSTEM_PROMPT },
        { role: 'user', content: buildRfpScopeUserPrompt(args) },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { ok: false, reason: 'AI returned an empty response.' };
    return { ok: true, value: text };
  } catch (e) {
    return { ok: false, reason: friendlyError(e) };
  }
}

// ─── 2. Bid comparison ───────────────────────────────────────────────────────

export type CompareBidsValue =
  | { kind: 'parsed'; comparison: BidComparison }
  | { kind: 'raw'; text: string };

export async function compareBids(args: {
  rfpScope: string;
  bids: Array<{
    bidIndex: number;
    priceUsdc: string;
    timelineDays: number;
    scope: string;
    milestones: Array<{ name: string; amountUsdc: string; durationDays: number }>;
  }>;
}): Promise<AiResult<CompareBidsValue>> {
  const client = getQvacClient();
  if (!client) return { ok: false, reason: NOT_CONFIGURED_REASON };
  try {
    const completion = await client.chat.completions.create({
      model: TENDR_MODEL_ALIAS,
      ...DEFAULT_GEN_PARAMS,
      // Bid comparison output is structured + can run long with N bids;
      // give it the full ctx allowance.
      max_tokens: 4096,
      messages: [
        { role: 'system', content: BID_COMPARISON_SYSTEM_PROMPT },
        { role: 'user', content: buildBidComparisonUserPrompt(args) },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { ok: false, reason: 'AI returned an empty response.' };
    const parsed = parseBidComparison(text);
    if (parsed) return { ok: true, value: { kind: 'parsed', comparison: parsed } };
    // Model went off-format — surface the raw text so the buyer at least
    // gets something useful, instead of a hard error.
    return { ok: true, value: { kind: 'raw', text } };
  } catch (e) {
    return { ok: false, reason: friendlyError(e) };
  }
}

// ─── 3. Provider bid drafting ────────────────────────────────────────────────

export async function draftBid(args: {
  rfpScope: string;
  rfpTitle?: string;
  category?: string;
  buyerSuggestedBudgetUsdc?: string;
}): Promise<AiResult<string>> {
  const client = getQvacClient();
  if (!client) return { ok: false, reason: NOT_CONFIGURED_REASON };
  try {
    const completion = await client.chat.completions.create({
      model: TENDR_MODEL_ALIAS,
      ...DEFAULT_GEN_PARAMS,
      messages: [
        { role: 'system', content: BID_DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildBidDraftUserPrompt(args) },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) return { ok: false, reason: 'AI returned an empty response.' };
    return { ok: true, value: text };
  } catch (e) {
    return { ok: false, reason: friendlyError(e) };
  }
}

// ─── error formatting ────────────────────────────────────────────────────────

/**
 * Convert an OpenAI SDK error or generic exception into a single-line
 * string suitable for showing in a toast. We don't surface raw SDK
 * messages because they often leak the model name / endpoint URL,
 * which is noise for the user and a tiny information leak about our
 * sidecar URL on Nosana.
 */
function friendlyError(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/network|fetch|aborted|timeout/i.test(msg)) {
    return "Couldn't reach the AI sidecar. Is the Nosana endpoint up?";
  }
  if (/404|not found|model/i.test(msg)) {
    return 'AI sidecar is up but the model is not loaded yet. Try again in a few seconds.';
  }
  if (/429|rate|quota/i.test(msg)) {
    return 'AI is busy with another request. Try again in a moment.';
  }
  return 'AI request failed. Try again.';
}

// ─── re-exports ──────────────────────────────────────────────────────────────

export { isAiAvailable };
export type { BidComparison } from './types';
