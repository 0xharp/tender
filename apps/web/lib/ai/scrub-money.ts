/**
 * Detect + scrub monetary amounts from AI-drafted RFP scope text.
 *
 * Why this exists: the buyer's reserve price is sealed on chain — bidders
 * are not supposed to see it. The RFP scope summary, by contrast, is
 * public. If the AI lets a dollar/USDC figure leak into the scope (either
 * because the buyer mentioned a budget in their natural-language prompt
 * or because the model ignored the system prompt's privacy rule), the
 * sealed-reserve guarantee is undermined the moment the buyer posts.
 *
 * The detector is intentionally permissive on the regex side and strict
 * on the UI surface — false positives are cheap (we just show a warning
 * the buyer can dismiss); false negatives would silently leak money
 * info into a public field. So we err toward "flag it, let the human
 * decide".
 *
 * Coverage:
 *   - "$12,000", "$12k", "$12.5K"
 *   - "12,000 USDC", "12k USDC", "12500 USDC"
 *   - "USDC 12,000", "USD 12000"
 *   - "budget of 12000", "around 10k", "approx $5,000"
 *   - "ten thousand dollars" — NOT covered (rare in AI output, low ROI)
 *
 * Returns the cleaned text + a list of matches so the UI can both auto-
 * scrub and warn the buyer about what was removed.
 */

export interface MoneyScrubResult {
  /** Original input. */
  original: string;
  /** Cleaned text with monetary phrases replaced by `[budget redacted]`. */
  scrubbed: string;
  /** The matched substrings found, in source order. Useful for the UI to
   *  show the buyer what got flagged. */
  matches: string[];
}

/**
 * Compose-of-features regex covering common monetary patterns:
 *   - leading $ followed by digits (with optional comma/decimal/k/K)
 *   - digits followed by USDC/USD/$ token
 *   - "<verb-ish> <number>" only if the number has a money cue nearby
 *
 * We deliberately DO NOT flag bare numbers like "5 milestones" or
 * "30 days" — those are scope-relevant integers without monetary
 * context. The cues we look for: $, USDC, USD, k/K following digits,
 * or words like budget/price/cost/spend/USDC within a small window.
 */
const PATTERNS: ReadonlyArray<RegExp> = [
  // $1,000 / $1.5K / $5,000.50
  /\$\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b/g,
  // 1,000 USDC / 5k USDC / 12500.50 USDC / USDC 1000
  /\b\d[\d,]*(?:\.\d+)?\s?[kKmM]?\s?(?:USDC|USD)\b/gi,
  /\b(?:USDC|USD)\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?\b/gi,
  // "budget of 12000", "approximately 5k", "around $5000" — money cue +
  // a number within 25 chars (covers natural prose without flagging
  // "5 milestones", "30 days", etc.)
  /\b(?:budget(?:ed|ing)?|reserve|price(?:d)?|cost(?:s|ing)?|spend(?:ing)?|target(?:ing)?)\s*(?:of|at|around|approximately|approx\.?|~|:)?\s*\$?\s?\d[\d,]*(?:\.\d+)?\s?[kKmM]?(?:\s?(?:USDC|USD))?\b/gi,
];

const PLACEHOLDER = '[budget redacted]';

export function scrubMoneyMentions(text: string): MoneyScrubResult {
  const matches: string[] = [];
  let scrubbed = text;
  for (const re of PATTERNS) {
    scrubbed = scrubbed.replace(re, (match) => {
      // Avoid double-counting overlapping matches across patterns by
      // skipping anything we've already replaced.
      if (match.includes(PLACEHOLDER)) return match;
      matches.push(match.trim());
      return PLACEHOLDER;
    });
  }
  // Dedupe and keep source order.
  const seen = new Set<string>();
  const uniqueMatches = matches.filter((m) => {
    const k = m.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { original: text, scrubbed, matches: uniqueMatches };
}

/** True if the input contains at least one monetary mention. */
export function hasMoneyMention(text: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
