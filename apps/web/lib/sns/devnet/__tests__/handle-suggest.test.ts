/**
 * Suggester invariants — every output should pass `validateHandle` and
 * never collide with the reserved blocklist. We run a sample of N
 * suggestions to catch any regression in the wordlists or assembly.
 */
import { describe, expect, test } from 'vitest';

import { suggestHandle } from '../handle-suggest';
import { HANDLE_MAX_LEN, HANDLE_MIN_LEN, validateHandle } from '../handle-validation';

describe('suggestHandle', () => {
  test('returns a non-empty string', () => {
    expect(suggestHandle().length).toBeGreaterThan(0);
  });

  test('every suggestion (over 200 samples) passes validateHandle', () => {
    for (let i = 0; i < 200; i++) {
      const candidate = suggestHandle();
      const result = validateHandle(candidate);
      // If a suggestion fails validation, surface what + why.
      if (!result.ok) {
        throw new Error(`Suggestion "${candidate}" failed: ${result.reason}`);
      }
      expect(candidate.length).toBeGreaterThanOrEqual(HANDLE_MIN_LEN);
      expect(candidate.length).toBeLessThanOrEqual(HANDLE_MAX_LEN);
    }
  });

  test('produces some variety (200 samples → at least 50 unique)', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 200; i++) samples.add(suggestHandle());
    // Pool of ~50 adj × ~50 noun × 100 (suffix) = 250k options. 200 random
    // draws should give ~200 unique. Loosen to 50 for stability under
    // pathological randomness.
    expect(samples.size).toBeGreaterThan(50);
  });
});
