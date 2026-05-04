/**
 * Cache invariants:
 *   - read returns undefined when nothing's cached
 *   - read returns null (cached negative) within negative TTL
 *   - read returns the .sol name within positive TTL
 *   - read returns undefined (forces re-resolve) past TTL
 *   - write seeds both in-memory + sessionStorage layers
 *   - prime bulk-writes
 */
import type { Address } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { _clearSnsCacheForTests, primeSnsCache, readSnsCache, writeSnsCache } from '../cache';

const ALICE = '4xRC1bvVqYNvJ7vQGhB4HUcWfFzqKn3aXtnVDdkjN3n7' as Address;
const BOB = 'BvJ7vQGhB4HUcWfFzqKn3aXtnVDdkjN3n74xRC1bvVqY' as Address;

describe('sns cache', () => {
  beforeEach(() => {
    _clearSnsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('read on a never-seen wallet returns undefined', () => {
    expect(readSnsCache(ALICE)).toBeUndefined();
  });

  test('write a name then read returns it within TTL', () => {
    writeSnsCache(ALICE, 'alice.sol');
    expect(readSnsCache(ALICE)).toBe('alice.sol');
  });

  test('write a negative (null) then read returns null within TTL', () => {
    writeSnsCache(ALICE, null);
    expect(readSnsCache(ALICE)).toBeNull();
  });

  test('positive cache survives long past the negative TTL (sticky names)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    writeSnsCache(ALICE, 'alice.sol');
    // 11 minutes — past negative TTL (10m) but well within positive TTL (24h)
    vi.setSystemTime(11 * 60 * 1000);
    expect(readSnsCache(ALICE)).toBe('alice.sol');
  });

  test('negative cache expires past negative TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    writeSnsCache(ALICE, null);
    // 11 minutes — past negative TTL
    vi.setSystemTime(11 * 60 * 1000);
    expect(readSnsCache(ALICE)).toBeUndefined();
  });

  test('positive cache expires past positive TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    writeSnsCache(ALICE, 'alice.sol');
    // 25 hours — past positive TTL (24h)
    vi.setSystemTime(25 * 60 * 60 * 1000);
    expect(readSnsCache(ALICE)).toBeUndefined();
  });

  test('prime bulk-writes', () => {
    const map = new Map<Address, string | null>([
      [ALICE, 'alice.sol'],
      [BOB, null],
    ]);
    primeSnsCache(map);
    expect(readSnsCache(ALICE)).toBe('alice.sol');
    expect(readSnsCache(BOB)).toBeNull();
  });

  test('two wallets do not collide', () => {
    writeSnsCache(ALICE, 'alice.sol');
    writeSnsCache(BOB, 'bob.sol');
    expect(readSnsCache(ALICE)).toBe('alice.sol');
    expect(readSnsCache(BOB)).toBe('bob.sol');
  });
});
