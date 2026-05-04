'use client';

/**
 * React hook for SNS reverse-resolution. Cache-aware: returns the cached
 * value synchronously on the first render if available, otherwise kicks
 * off a background resolve and re-renders when the result lands.
 *
 * The PRIVACY INVARIANT: don't pass ephemeral bid signers as the wallet
 * input. See `resolve.ts` top-of-file. The hook doesn't enforce; the
 * convention is "callers know which wallets are safe."
 */
import type { Address } from '@solana/kit';
import { useEffect, useState } from 'react';

import { snsRpc } from '@/lib/solana/client';

import { readSnsCache, writeSnsCache } from './cache';
import { resolveWalletToSns } from './resolve';

/**
 * Returns the wallet's primary `.sol` name, or null if unresolved /
 * unknown. The undefined return means "not yet resolved this render"
 * — caller should treat that as the loading state if it cares. Most UIs
 * just `return name ?? <fallback />` and don't distinguish.
 *
 * Hydration-safe: ALWAYS returns undefined on the first render (server
 * + first client render produce identical DOM), then reads cache + fires
 * resolve in useEffect after mount. If we initialized state with the
 * cached value synchronously, server (no sessionStorage) and client
 * (has sessionStorage with the .sol name) would produce different DOM
 * and React would fire a hydration mismatch warning. The one-frame
 * "flash" of truncated-hash → .sol-name is invisible to users since
 * the cache hit fires immediately on mount.
 */
export function useSnsName(wallet: Address | null | undefined): string | null | undefined {
  // CRITICAL: do NOT initialize from cache here. Server has no
  // sessionStorage so it'd return undefined; client would return the
  // cached .sol name. Different initial render → hydration mismatch.
  // Always start undefined; useEffect populates after mount.
  const [name, setName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!wallet) {
      setName(undefined);
      return;
    }
    // If we have a fresh cached value, no work needed - just paint it.
    const c = readSnsCache(wallet);
    if (c !== undefined) {
      setName(c);
      return;
    }
    // Cold path: fire the resolve, write the cache on completion.
    let cancelled = false;
    setName(undefined);
    void resolveWalletToSns(snsRpc, wallet).then((resolved) => {
      writeSnsCache(wallet, resolved);
      if (!cancelled) setName(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  return name;
}
