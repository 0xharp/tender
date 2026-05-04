/**
 * Two-tier cache for SNS reverse-resolutions (wallet → .sol name).
 *
 * Tier 1: in-memory Map. Populated on every successful resolve. Survives
 * a single page session, dies on tab close. Hot path — every render of
 * a HashLink with `withSns` checks this first.
 *
 * Tier 2: sessionStorage. Same lifetime as in-memory but survives
 * client-side navigation (Next router pushes don't unmount the cache
 * holder, but we hydrate from sessionStorage on first call to be safe).
 *
 * Why not localStorage: we don't want to persist names to disk. SNS
 * names are public, but caching them indefinitely creates a "what do I
 * have on this user" surface that has no business being there. A tab
 * session is plenty.
 *
 * Negative results are cached too (null = "no .sol found") with a
 * shorter TTL — wallets that don't have a .sol today might set one
 * tomorrow, and we don't want a stale negative to mask that.
 *
 * PRIVACY INVARIANT: cache keys are wallet addresses. Caller is
 * responsible for never passing ephemeral bid signers (see resolve.ts
 * top-of-file). Cache doesn't enforce; it caches whatever it's told.
 */
import type { Address } from '@solana/kit';

interface CacheEntry {
  /** The resolved .sol name, or null if no primary domain is set. */
  name: string | null;
  /** Unix ms when this entry was written. Compare to TTL on read. */
  cachedAt: number;
}

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — names are sticky
const NEGATIVE_TTL_MS = 10 * 60 * 1000; // 10m — recheck quickly

/** In-memory layer. Survives within one tab + tree mount. */
const memoryCache = new Map<Address, CacheEntry>();

const STORAGE_KEY_PREFIX = 'tender:sns:';

function storageKey(wallet: Address): string {
  return `${STORAGE_KEY_PREFIX}${wallet}`;
}

function readSessionStorage(wallet: Address): CacheEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey(wallet));
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}

function writeSessionStorage(wallet: Address, entry: CacheEntry): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(storageKey(wallet), JSON.stringify(entry));
  } catch {
    // Quota or sessionStorage disabled - in-memory still works.
  }
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.name === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
  return Date.now() - entry.cachedAt < ttl;
}

/** Read from cache (memory first, then session storage). Returns
 *  undefined if no usable cached value. Note `null` is a valid CACHED
 *  value meaning "we checked and there's no .sol" — distinct from
 *  undefined which means "never resolved or expired". */
export function readSnsCache(wallet: Address): string | null | undefined {
  const mem = memoryCache.get(wallet);
  if (mem && isFresh(mem)) return mem.name;
  const session = readSessionStorage(wallet);
  if (session && isFresh(session)) {
    // Hydrate the in-memory layer so subsequent reads are O(1).
    memoryCache.set(wallet, session);
    return session.name;
  }
  return undefined;
}

/** Write a resolution result to both layers. */
export function writeSnsCache(wallet: Address, name: string | null): void {
  const entry: CacheEntry = { name, cachedAt: Date.now() };
  memoryCache.set(wallet, entry);
  writeSessionStorage(wallet, entry);
}

/** Bulk-prime the cache after a batch resolve. Used by the leaderboard
 *  flow to populate every row's resolution from a single getMultipleAccounts. */
export function primeSnsCache(results: Map<Address, string | null>): void {
  for (const [wallet, name] of results.entries()) {
    writeSnsCache(wallet, name);
  }
}

/** Invalidate a single wallet's cache entry across both tiers. Used
 *  after a successful claim so the freshly-minted name supersedes any
 *  stale negative cache from a pre-claim resolve attempt. */
export function invalidateSnsCache(wallet: Address): void {
  memoryCache.delete(wallet);
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.removeItem(storageKey(wallet));
    } catch {
      // ignore - in-memory delete is enough; next session resets sessionStorage
    }
  }
}

/** Test-only escape hatch. Don't call from product code. */
export function _clearSnsCacheForTests(): void {
  memoryCache.clear();
  if (typeof window !== 'undefined') {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k?.startsWith(STORAGE_KEY_PREFIX)) keys.push(k);
      }
      for (const k of keys) window.sessionStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}
