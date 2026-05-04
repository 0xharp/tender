/**
 * Handle validation for tendr identity claims. Two layers:
 *
 *   1. Lexical validation — length + charset. Mirrors what SNS itself
 *      considers a valid leaf name (alphanumeric + hyphen, no leading/
 *      trailing hyphen, no double hyphens). We add a min length so users
 *      can't squat 1-char identities.
 *   2. Reserved blocklist — handles that look like internal/system roles
 *      or that we want to keep available for legitimate use later. Small
 *      hand-curated list; not a profanity filter.
 *
 * `validateHandle(input)` returns `{ ok: true, normalized }` or
 * `{ ok: false, reason }`. The normalized form is lowercase + trimmed,
 * which is what gets minted on-chain.
 *
 * Availability (already-claimed-on-chain) is a separate check — see
 * `isTendrHandleTaken` in resolve.ts.
 */

const MIN_LEN = 3;
const MAX_LEN = 20;
const ALLOWED_CHARSET = /^[a-z0-9-]+$/;
const NO_LEADING_HYPHEN = /^[^-]/;
const NO_TRAILING_HYPHEN = /[^-]$/;
const NO_DOUBLE_HYPHEN = /^(?!.*--)/;

// Hand-curated blocklist. Three categories: system/admin handles users
// might confuse for official tendr.bid roles, common reserved web names,
// and a small set of brand/team names we want to hold. Not exhaustive —
// add to it as we see abuse patterns.
const RESERVED_HANDLES = new Set<string>([
  // Admin / system
  'admin',
  'administrator',
  'root',
  'system',
  'sys',
  'superuser',
  'superadmin',
  'mod',
  'moderator',
  'staff',
  'support',
  'official',
  'team',
  'owner',
  // Common web-app reserved
  'www',
  'api',
  'app',
  'web',
  'mail',
  'email',
  'login',
  'signin',
  'signup',
  'register',
  'logout',
  'signout',
  'auth',
  'oauth',
  'account',
  'accounts',
  'dashboard',
  'settings',
  'config',
  'profile',
  'home',
  'index',
  // Tendr brand / role
  'tendr',
  'tendrbid',
  'tendrdotbid',
  'tender',
  // Common content / policy paths
  'docs',
  'doc',
  'documentation',
  'blog',
  'news',
  'about',
  'contact',
  'help',
  'faq',
  'pricing',
  'terms',
  'privacy',
  'legal',
  'security',
  'status',
  'changelog',
  // High-confusion crypto terms
  'wallet',
  'multisig',
  'treasury',
  'escrow',
  'rfp',
  'bid',
  'bidder',
  'buyer',
  'provider',
  'winner',
  'solana',
  'usdc',
  'sol',
  // Test / placeholder
  'test',
  'tester',
  'testing',
  'demo',
  'example',
  'placeholder',
  'null',
  'undefined',
]);

export type HandleValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Validate + normalize a user-supplied handle. Idempotent — calling
 * this on an already-normalized handle returns `{ok:true}` with the
 * same string back.
 *
 * Failure reasons are user-facing strings (kept short, declarative).
 */
export function validateHandle(input: string): HandleValidationResult {
  if (typeof input !== 'string') {
    return { ok: false, reason: 'Handle must be a string.' };
  }
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0) {
    return { ok: false, reason: 'Pick a handle.' };
  }
  if (normalized.length < MIN_LEN) {
    return { ok: false, reason: `Handle must be at least ${MIN_LEN} characters.` };
  }
  if (normalized.length > MAX_LEN) {
    return { ok: false, reason: `Handle must be at most ${MAX_LEN} characters.` };
  }
  if (!ALLOWED_CHARSET.test(normalized)) {
    return { ok: false, reason: 'Use only lowercase letters, numbers, and hyphens.' };
  }
  if (!NO_LEADING_HYPHEN.test(normalized)) {
    return { ok: false, reason: 'Handle cannot start with a hyphen.' };
  }
  if (!NO_TRAILING_HYPHEN.test(normalized)) {
    return { ok: false, reason: 'Handle cannot end with a hyphen.' };
  }
  if (!NO_DOUBLE_HYPHEN.test(normalized)) {
    return { ok: false, reason: 'Handle cannot contain two hyphens in a row.' };
  }
  if (RESERVED_HANDLES.has(normalized)) {
    return { ok: false, reason: 'That handle is reserved.' };
  }
  return { ok: true, normalized };
}

/** Exposed for tests / scripts. */
export { MAX_LEN as HANDLE_MAX_LEN, MIN_LEN as HANDLE_MIN_LEN, RESERVED_HANDLES };
