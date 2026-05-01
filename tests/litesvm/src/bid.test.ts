/**
 * Bid lifecycle tests — DISABLED for Day 6 (PER migration).
 *
 * The bid-submit, withdraw, and reveal flows now require MagicBlock PER
 * permission accounts + Magic Action runtime that LiteSVM doesn't simulate.
 *
 * Coverage gap is filled by:
 *   - Rust LiteSVM tests in `programs/tender/tests/litesvm_state.rs`
 *     (init-side state + bid_pda_seed validation + L0/L1 identity binding)
 *   - Phase G devnet integration test (live PER, end-to-end manual)
 *
 * TODO: rewrite with a lightweight PER mock once available, or move into a
 * separate devnet-required vitest suite.
 */
import { describe, it } from 'vitest';

describe.skip('bid lifecycle (disabled — see Day 6 PRIVACY-MODEL.md + devnet flow)', () => {
  it('skipped', () => undefined);
});
