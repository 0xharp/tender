/**
 * Resolve helper invariants:
 *   - normalizeSnsInput strips @ + .sol consistently
 *   - withSolSuffix is idempotent
 *
 * The actual SNS RPC calls are not unit-tested here — they're integration
 * paths that need a live (or mocked) Solana RPC. Cache + normalize is what
 * benefits from unit tests; the resolve* functions are thin wrappers we
 * verify via the dev/staging environment.
 */
import { describe, expect, test } from 'vitest';

import { normalizeSnsInput, withSolSuffix } from '../resolve';

describe('normalizeSnsInput', () => {
  test('strips @ prefix', () => {
    expect(normalizeSnsInput('@alice')).toBe('alice');
  });

  test('strips .sol suffix', () => {
    expect(normalizeSnsInput('alice.sol')).toBe('alice');
  });

  test('strips both', () => {
    expect(normalizeSnsInput('@alice.sol')).toBe('alice');
  });

  test('trims whitespace', () => {
    expect(normalizeSnsInput('  alice.sol  ')).toBe('alice');
  });

  test('handles uppercase suffix', () => {
    expect(normalizeSnsInput('alice.SOL')).toBe('alice');
  });

  test('passes through clean input', () => {
    expect(normalizeSnsInput('alice')).toBe('alice');
  });

  test('empty input', () => {
    expect(normalizeSnsInput('')).toBe('');
  });
});

describe('withSolSuffix', () => {
  test('appends when missing', () => {
    expect(withSolSuffix('alice')).toBe('alice.sol');
  });

  test('idempotent when present', () => {
    expect(withSolSuffix('alice.sol')).toBe('alice.sol');
  });

  test('handles uppercase suffix', () => {
    expect(withSolSuffix('alice.SOL')).toBe('alice.SOL');
  });
});
