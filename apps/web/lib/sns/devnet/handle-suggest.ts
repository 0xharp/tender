/**
 * Wordlist suggester for the claim-identity modal's "Suggest" button.
 *
 * Generates `<adjective><noun><digit?>` style handles, all lowercase, no
 * separator (saves chars vs `swift-river`-style). The pools are small
 * (~50×50) but combining them yields ~2,500 base options, plus optional
 * digit suffix → ~25,000 — plenty of headroom for a hackathon scale.
 *
 * Output is guaranteed to satisfy `validateHandle`'s lexical rules
 * (length <= MAX, charset clean, no leading/trailing hyphens). Caller
 * should still check availability via `isTendrHandleTaken`.
 */
import { HANDLE_MAX_LEN, RESERVED_HANDLES } from './handle-validation';

const ADJECTIVES = [
  'swift', 'sharp', 'bright', 'quiet', 'bold', 'calm', 'crisp', 'clear',
  'deep', 'fair', 'fast', 'fine', 'firm', 'fresh', 'gold', 'grand',
  'keen', 'kind', 'lean', 'light', 'loyal', 'lucky', 'mint', 'noble',
  'open', 'pure', 'rapid', 'royal', 'solid', 'steady', 'sturdy', 'sure',
  'tall', 'tidy', 'tough', 'trim', 'true', 'vivid', 'warm', 'wise',
  'agile', 'alpha', 'azure', 'cosmic', 'flux', 'lunar', 'neon', 'nova',
  'prime', 'sage',
];

const NOUNS = [
  'river', 'forest', 'cloud', 'wave', 'peak', 'star', 'spark', 'echo',
  'comet', 'crane', 'falcon', 'fox', 'hawk', 'heron', 'lynx', 'otter',
  'orca', 'panda', 'pine', 'reef', 'ridge', 'silk', 'stone', 'tide',
  'whale', 'wolf', 'fern', 'glade', 'grove', 'ember', 'flint', 'quartz',
  'amber', 'opal', 'jade', 'onyx', 'rune', 'arc', 'beam', 'core',
  'edge', 'frost', 'glow', 'haze', 'lens', 'mesh', 'node', 'orbit',
  'prism', 'vault',
];

function pick<T>(arr: readonly T[]): T {
  // crypto.getRandomValues for unbiased selection. Fallback to Math.random
  // if (somehow) crypto is unavailable - module is browser-OR-node, both
  // expose globalThis.crypto in modern runtimes.
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return arr[buf[0]! % arr.length]!;
  }
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * Generate a candidate handle. Caller should `validateHandle` + check
 * availability with `isTendrHandleTaken` before committing.
 *
 * The handle is GUARANTEED valid against `validateHandle` lexical rules
 * (we ensure it stays under MAX_LEN, charset is alphanumeric, no
 * hyphens used) but NOT guaranteed unclaimed — that's a chain query.
 */
export function suggestHandle(): string {
  // Try a few combos to avoid hitting the reserved blocklist (extremely
  // unlikely with these word pools, but cheap to defend against).
  for (let attempt = 0; attempt < 10; attempt++) {
    const adj = pick(ADJECTIVES);
    const noun = pick(NOUNS);
    let candidate = adj + noun;
    if (candidate.length > HANDLE_MAX_LEN) continue;
    // Optional 2-digit suffix gives variety for shorter base words and
    // lowers collision odds. Append only if it still fits.
    if (candidate.length <= HANDLE_MAX_LEN - 2) {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      const suffix = (buf[0]! % 100).toString().padStart(2, '0');
      candidate = candidate + suffix;
    }
    if (RESERVED_HANDLES.has(candidate)) continue;
    return candidate;
  }
  // Pathological fallback: very short fixed-prefix + random digit.
  // Should be unreachable for the configured pool sizes.
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return `user${(buf[0]! % 100000).toString().padStart(5, '0')}`;
}
