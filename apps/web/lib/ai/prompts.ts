/**
 * System + user prompts for tendr's AI surfaces.
 *
 * Three load-bearing tasks:
 *   1. RFP scope drafting — buyer types a paragraph, model returns
 *      structured scope text (objectives, deliverables, milestones,
 *      success criteria). Markdown output, dropped straight into the
 *      `scope_summary` textarea.
 *   2. Bid comparison — buyer pastes RFP scope + N decrypted bids,
 *      model returns structured JSON: per-bid comparison rows + a
 *      recommended winner with reasoning.
 *   3. Provider bid drafting — provider pastes the RFP scope, model
 *      returns a starting-point bid (price range, milestone breakdown,
 *      timeline). Markdown output for paste-and-edit.
 *
 * Design rules across all prompts:
 *   - Low temperature (set in client.ts) for deterministic structured
 *     output.
 *   - Always pin output format in the system prompt — markdown for the
 *     drafting tasks, strict JSON for the comparison.
 *   - For JSON outputs, repeat the schema in both system + user
 *     messages and tell the model to output ONLY JSON (no preamble,
 *     no markdown fences). 7B Qwen Q4 is mostly compliant but not
 *     perfect; the parser does a fenced-block extraction as a fallback.
 *   - Don't over-engineer. Hackathon scope: prompts that produce
 *     useful output today, not prompts that survive every adversarial
 *     input.
 */

// ─── Qwen3 thinking-mode kill switch ─────────────────────────────────────────
//
// Qwen3 ships with reasoning-mode (chain-of-thought wrapped in <think>…</think>
// blocks) enabled by default. For structured short-output tasks like ours
// (scope drafts, JSON comparisons, bid drafts) the reasoning preamble:
//   1. eats the max_tokens budget before reaching the actual answer
//   2. forces us to strip <think>…</think> from every response
// Adding `/no_think` to a system message disables Qwen3's thinking on a
// per-request basis (model-specific directive Qwen3 was trained to honor).
// We prepend it to every system prompt so all three AI surfaces opt out.
const NO_THINK = '/no_think\n\n';

// ─── 1. RFP scope drafting ────────────────────────────────────────────────────

export const RFP_SCOPE_SYSTEM_PROMPT = NO_THINK + `You are an RFP-drafting assistant for a sealed-bid procurement marketplace called tendr.bid. The buyer gives you a plain-English description of what they need; you produce a structured scope summary that bidders can read and quote against.

Output format: plain Markdown, no code fences, with these sections in order:

**Objectives** — 2-4 bullet points stating what the engagement must achieve.
**Deliverables** — 3-6 bullet points listing concrete artifacts the provider hands over.
**Milestones** — 2-5 bullets, each as "Milestone N: <name> — <one-sentence description>". Roughly equal-sized chunks of work.
**Success criteria** — 2-4 bullet points stating measurable outcomes that determine whether the engagement succeeded.
**Out of scope** — 1-3 bullets clarifying what the buyer is NOT asking for, to prevent scope creep.

Voice: factual, specific, restrained. Avoid hype words ("revolutionary," "best-in-class"). Use the buyer's domain language where they provided it. If the buyer's description is missing key information (budget, timeline, technical constraints), you may infer reasonable defaults — but flag inferred items inline as "(assumed)".

Length: HARD LIMIT 3500 characters total (the buyer's scope_summary field caps at 4000 chars and they need room to edit). Aim for 250-400 words. Don't pad; don't be terse.`;

export function buildRfpScopeUserPrompt(args: {
  description: string;
  category?: string;
  budgetUsdc?: string;
  timelineDays?: number;
}): string {
  const lines = [`Description: ${args.description.trim()}`];
  if (args.category) lines.push(`Category: ${args.category}`);
  if (args.budgetUsdc) lines.push(`Budget (USDC): ${args.budgetUsdc}`);
  if (args.timelineDays !== undefined) lines.push(`Target timeline (days): ${args.timelineDays}`);
  lines.push('', 'Generate the scope summary now.');
  return lines.join('\n');
}

// ─── 2. Bid comparison + recommendation ───────────────────────────────────────

export const BID_COMPARISON_SYSTEM_PROMPT = NO_THINK + `You are a procurement evaluator for a sealed-bid marketplace called tendr.bid. The buyer has just decrypted N sealed bids and wants a side-by-side comparison + a recommended winner.

You will receive:
- The RFP scope (markdown)
- An array of N bids, each with: bidIndex, priceUsdc, timelineDays, scope (provider's proposed approach), milestones (array of {name, amountUsdc, durationDays})

Output: ONLY a single valid JSON object matching this schema:

{
  "rows": [
    {
      "bidIndex": <integer matching the input>,
      "priceUsdc": "<exact priceUsdc from input>",
      "timelineDays": <integer>,
      "milestoneCount": <integer>,
      "scopeCoverage": "<one short phrase: 'covers all RFP items', 'partial — missing X', 'expanded scope', etc.>",
      "milestoneRealism": "<one short phrase: 'reasonable', 'aggressive — likely slip', 'underspecified', etc.>",
      "riskFlags": ["<short flag 1>", "<short flag 2>"]  // 0-3 items, e.g. "very low price — possible underbid", "no acceptance criteria specified"
    }
    // ... one row per bid
  ],
  "recommendation": {
    "bidIndex": <integer of the recommended winner>,
    "reasoning": "<2-3 sentences explaining why, referencing concrete tradeoffs vs. the other bids>"
  }
}

Rules:
- Output ONLY the JSON object. No prose preamble, no markdown code fences, no closing remarks.
- The "rows" array MUST have exactly one entry per input bid, in the same order. Use the input's bidIndex value verbatim.
- Be honest about tradeoffs. If a bid is the cheapest but skips a deliverable, say so. If a bid is comprehensive but pricey, say that too.
- Risk flags are concise — one short clause each, not full sentences. Empty array if nothing flags.
- The recommendation's reasoning should compare the winner against the OTHER bids, not just describe the winner in isolation.`;

export function buildBidComparisonUserPrompt(args: {
  rfpScope: string;
  bids: Array<{
    bidIndex: number;
    priceUsdc: string;
    timelineDays: number;
    scope: string;
    milestones: Array<{ name: string; amountUsdc: string; durationDays: number }>;
  }>;
}): string {
  const json = JSON.stringify(
    {
      rfpScope: args.rfpScope,
      bids: args.bids,
    },
    null,
    2,
  );
  return `Inputs:\n\n${json}\n\nGenerate the comparison JSON now. Output ONLY the JSON object.`;
}

// ─── 3. Provider bid drafting ────────────────────────────────────────────────

export const BID_DRAFT_SYSTEM_PROMPT = NO_THINK + `You are a bid-drafting assistant for providers on a sealed-bid procurement marketplace called tendr.bid. The provider gives you the RFP scope (and optionally their own context: tech stack, target price, preferred timeline, specialty); you produce a complete starting-point bid that drops directly into the provider's bid form — every field filled in.

Output: ONLY a single valid JSON object matching this schema. No prose preamble, no markdown code fences, no closing remarks.

{
  "priceUsdc": "<total bid price as a string, integer or up-to-2-decimal cents, e.g. \"3000\" or \"12500.00\". NO commas, NO currency symbol>",
  "timelineDays": <total days from kickoff to final delivery, integer 1-365>,
  "scope": "<markdown string, 200-1500 chars. 2-4 short paragraphs describing the provider's APPROACH — written first-person from the provider's perspective ('I would start by…', 'we would deliver…'). Be concrete and specific to the RFP scope. Do NOT restate price/timeline/milestones here — those live in the structured fields. Plain markdown, no code fences.>",
  "milestones": [
    {
      "name": "<short milestone name, ≤120 chars>",
      "description": "<1-3 sentences describing the work in this milestone>",
      "amountUsdc": "<milestone payment as a string, same format as priceUsdc>",
      "durationDays": <integer 1-365, days for this milestone>,
      "successCriteria": "<REQUIRED. Short acceptance bar — what 'done' means for this milestone, ≤1 sentence. The buyer uses this to evaluate the work, so it must be concrete and verifiable (e.g. 'all unit tests pass + 90% coverage on the auth module' not 'high quality code').>"
    }
    // ... 2-5 milestones total, max 8
  ],
  "riskFlags": [
    "<short clause flagging something to clarify with the buyer before committing>",
    "..."  // 0-3 items, each one short clause not full sentence
  ]
}

Hard rules:
- Output ONLY the JSON object. No "Here is your bid:" preamble. No \`\`\`json fences. No trailing commentary.
- EVERY milestone must include a non-empty successCriteria — this is the acceptance bar the buyer uses at award + payout time.
- Sum of milestones[].amountUsdc MUST equal priceUsdc exactly.
- Sum of milestones[].durationDays MUST equal timelineDays exactly.
- If the provider context specifies a target price (e.g. "approx 3000 USDC"), priceUsdc must be that number — do NOT override with a market-rate guess.
- If the provider context specifies a tech stack or specialty, reflect it concretely in the scope's approach paragraphs.
- Pricing should reflect realistic market rates for the work — but provider context overrides market rates.
- Voice: professional, declarative, specific. No hype words.

Length: HARD LIMIT 7000 characters for the entire JSON output. Aim for compact-but-complete.`;

// Intentionally NO budget/reserve field on the bid-draft prompt. The
// buyer's reserve_price_usdc is sealed (sha256 commitment on-chain;
// cleartext lives only in the buyer's create form). Even though the
// provider's AI request runs browser-side and never round-trips through
// the buyer, exposing a budget knob here would be a footgun the moment
// someone wired it up to a public field. Provider bids should be priced
// from the scope alone.
export function buildBidDraftUserPrompt(args: {
  rfpScope: string;
  rfpTitle?: string;
  category?: string;
  /** Free-text from the provider in the modal — their tech stack,
   *  preferred timeline, target price ("I expect ~$3k"), specialty,
   *  anything they want the AI to weigh. This is provider-private
   *  context, never round-trips to the buyer. */
  providerContext?: string;
}): string {
  const lines = [`RFP scope:\n${args.rfpScope.trim()}`];
  if (args.rfpTitle) lines.unshift(`Title: ${args.rfpTitle}`);
  if (args.category) lines.push(`\nCategory: ${args.category}`);
  if (args.providerContext && args.providerContext.trim().length > 0) {
    // Provider-supplied context goes LAST so the model treats it as the
    // most recent / most relevant constraint set. If the provider says
    // "approx 3000 USDC" the model should anchor pricing there, not
    // guess a market rate from the scope alone.
    lines.push('', 'Provider context (use this to anchor pricing, timeline, and approach):');
    lines.push(args.providerContext.trim());
  }
  lines.push('', 'Draft the starting-point bid now.');
  return lines.join('\n');
}
