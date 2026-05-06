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
import {
  type BidComparison,
  type BidDraft,
  parseBidComparison,
  parseBidDraft,
} from './types';

export type AiResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const NOT_CONFIGURED_REASON =
  'AI is not configured for this app. Set NEXT_PUBLIC_QVAC_BASE_URL to enable AI features.';

/**
 * Strip Qwen3 reasoning blocks from a model response.
 *
 * Qwen3 wraps chain-of-thought in `<think>…</think>`. We tell the model
 * to skip thinking via `/no_think` in every system prompt (see
 * prompts.ts), but if the directive is ignored or the response includes
 * partial reasoning we strip it here before returning to the UI. Both
 * a complete `<think>...</think>` block and a leading unclosed `<think>`
 * (when generation hit max_tokens mid-reasoning) are removed.
 */
function stripThinking(raw: string): string {
  // Closed blocks first - greedy across newlines.
  const closed = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
  // Then any leading unclosed <think> ... (no closer because gen ran out).
  return closed.replace(/^[\s\S]*?<think>[\s\S]*$/i, '').trim() || closed.trim();
}

// ─── 1. RFP scope drafting ───────────────────────────────────────────────────

export async function draftRfpScope(args: {
  description: string;
  category?: string;
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
    const text = stripThinking(completion.choices[0]?.message?.content ?? '');
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

/** Same parsed/raw discriminator as `compareBids` — when the model
 *  returns valid JSON we hand back the structured draft (which the
 *  modal uses to populate every bid form field on accept). When it
 *  drifts off-format we hand back the raw text so the user at least
 *  has something to copy. */
export type DraftBidValue =
  | { kind: 'parsed'; draft: BidDraft }
  | { kind: 'raw'; text: string };

export async function draftBid(args: {
  rfpScope: string;
  rfpTitle?: string;
  category?: string;
  /** Free-text the provider typed in the modal (tech stack, target
   *  price, preferred timeline, specialization). Anchors the model's
   *  pricing + approach. */
  providerContext?: string;
}): Promise<AiResult<DraftBidValue>> {
  const client = getQvacClient();
  if (!client) return { ok: false, reason: NOT_CONFIGURED_REASON };
  try {
    const completion = await client.chat.completions.create({
      model: TENDR_MODEL_ALIAS,
      ...DEFAULT_GEN_PARAMS,
      // Structured bid output runs longer than the old markdown blob —
      // ~2000 tokens covers price + timeline + scope markdown + 5
      // milestones with descriptions + risk flags. Prompt enforces the
      // 7000 char total budget.
      max_tokens: 2500,
      messages: [
        { role: 'system', content: BID_DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildBidDraftUserPrompt(args) },
      ],
    });
    const text = stripThinking(completion.choices[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: 'AI returned an empty response.' };
    const parsed = parseBidDraft(text);
    if (parsed) return { ok: true, value: { kind: 'parsed', draft: parsed } };
    // Off-format fallback — surface the raw text so the user at least
    // gets something to copy. Modal renders it in a read-only block.
    return { ok: true, value: { kind: 'raw', text } };
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
export type { BidComparison, BidDraft, BidDraftMilestone } from './types';
