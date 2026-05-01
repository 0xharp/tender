/**
 * select_bid tests — DISABLED for Day 6 (PER migration).
 *
 * select_bid now runs on the ER and chains a Magic Action to update the rfp
 * on base layer. LiteSVM doesn't simulate either piece, so this entire suite
 * is moved to the Phase G devnet integration test.
 */
import { describe, it } from 'vitest';

describe.skip('select_bid (disabled — see Day 6 PRIVACY-MODEL.md + devnet flow)', () => {
  it('skipped', () => undefined);
});
