/**
 * Lock in the validation contract — these rules are also enforced
 * server-side at /api/identity/check-handle and /api/identity/claim,
 * but the client modal does sync validation against this same module
 * for instant feedback. If the rule changes, both layers move together.
 */
import { describe, expect, test } from 'vitest';

import {
  HANDLE_MAX_LEN,
  HANDLE_MIN_LEN,
  RESERVED_HANDLES,
  validateHandle,
} from '../handle-validation';

describe('validateHandle — happy path', () => {
  test('accepts a normal handle', () => {
    expect(validateHandle('harp')).toEqual({ ok: true, normalized: 'harp' });
  });

  test('lowercases mixed-case input', () => {
    expect(validateHandle('SharPre')).toEqual({ ok: true, normalized: 'sharpre' });
  });

  test('trims leading/trailing whitespace', () => {
    expect(validateHandle('  harp  ')).toEqual({ ok: true, normalized: 'harp' });
  });

  test('accepts hyphens in the middle', () => {
    expect(validateHandle('big-fish')).toEqual({ ok: true, normalized: 'big-fish' });
  });

  test('accepts digits', () => {
    expect(validateHandle('user42')).toEqual({ ok: true, normalized: 'user42' });
  });

  test('accepts the minimum length', () => {
    const min = 'a'.repeat(HANDLE_MIN_LEN);
    expect(validateHandle(min)).toEqual({ ok: true, normalized: min });
  });

  test('accepts the maximum length', () => {
    const max = 'a'.repeat(HANDLE_MAX_LEN);
    expect(validateHandle(max)).toEqual({ ok: true, normalized: max });
  });
});

describe('validateHandle — lexical rejections', () => {
  test('rejects empty string', () => {
    const r = validateHandle('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Pick a handle/i);
  });

  test('rejects handles too short', () => {
    const r = validateHandle('ab');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at least/);
  });

  test('rejects handles too long', () => {
    const r = validateHandle('a'.repeat(HANDLE_MAX_LEN + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/at most/);
  });

  test('rejects uppercase that did not get lowercased — actually lowercases', () => {
    // Defensive: the function normalizes uppercase, so this should pass.
    expect(validateHandle('HARP')).toEqual({ ok: true, normalized: 'harp' });
  });

  test('rejects spaces', () => {
    const r = validateHandle('big fish');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/letters, numbers, and hyphens/);
  });

  test('rejects underscore', () => {
    const r = validateHandle('big_fish');
    expect(r.ok).toBe(false);
  });

  test('rejects dot', () => {
    const r = validateHandle('big.fish');
    expect(r.ok).toBe(false);
  });

  test('rejects emoji', () => {
    const r = validateHandle('big🐟fish');
    expect(r.ok).toBe(false);
  });

  test('rejects leading hyphen', () => {
    const r = validateHandle('-harp');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/start with a hyphen/);
  });

  test('rejects trailing hyphen', () => {
    const r = validateHandle('harp-');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/end with a hyphen/);
  });

  test('rejects double hyphen', () => {
    const r = validateHandle('big--fish');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/two hyphens/);
  });
});

describe('validateHandle — reserved blocklist', () => {
  test.each([
    'admin',
    'root',
    'system',
    'support',
    'tendr',
    'tendrbid',
    'wallet',
    'escrow',
    'test',
  ])('rejects reserved handle "%s"', (handle) => {
    const r = validateHandle(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/reserved/i);
  });

  test('reserved blocklist matches case-insensitively (input is lowercased)', () => {
    expect(validateHandle('ADMIN').ok).toBe(false);
  });

  test('non-reserved handles pass', () => {
    expect(validateHandle('harp').ok).toBe(true);
    expect(validateHandle('alice').ok).toBe(true);
  });
});

describe('RESERVED_HANDLES sanity', () => {
  test('includes the obvious admin / system roles', () => {
    expect(RESERVED_HANDLES.has('admin')).toBe(true);
    expect(RESERVED_HANDLES.has('root')).toBe(true);
  });

  test('includes the tendr brand handles', () => {
    expect(RESERVED_HANDLES.has('tendr')).toBe(true);
    expect(RESERVED_HANDLES.has('tendrbid')).toBe(true);
  });

  test('every reserved handle would itself pass lexical validation', () => {
    // Defense against accidentally adding e.g. "ad-min" or "admin!" to
    // the blocklist — reserved entries should be canonical handle shapes.
    for (const h of RESERVED_HANDLES) {
      const r = validateHandle(h);
      // Reserved blocks ARE rejected, but only by the reserved check —
      // not by lexical rules. Verify by temporarily checking the result
      // says "reserved" rather than e.g. "too short".
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/reserved/i);
      }
    }
  });
});
