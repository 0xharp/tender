/**
 * useKeychain — React hook for the v2 HD-keychain primitive.
 *
 * The pure crypto module lives at `@/lib/crypto/keychain`. This file is
 * the React-shaped wrapper that:
 *
 *   1. Lazily prompts the wallet for the master signature on first use
 *      via the existing `useTendrSignMessage` hook.
 *   2. Caches the derived master seed in tab-scoped state so subsequent
 *      ephemeral derivations are silent (no further wallet prompts).
 *   3. Exposes role-keyed derive helpers + an `isUnlocked` flag for UI
 *      that wants to gate "unlock keychain" CTAs.
 *
 * Cache scope: per-tab, in-memory only. New tab / page reload = one
 * new prompt. Encrypted-localStorage caching with PIN is v3 future
 * work; in-memory is the safest default.
 *
 * Compromise model: see `lib/crypto/keychain.ts` — same threat boundary
 * as the underlying primitive.
 */
'use client';

import type { Keypair } from '@solana/web3.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type KeychainRole,
  deriveBidderEphemeral,
  deriveBuyerEphemeral,
  deriveFundEphemeral,
  deriveKeychainSeedMessage,
  deriveMasterSeed,
  derivePayoutEphemeral,
  deriveRefundEphemeral,
  deriveSlotSeed,
} from '@/lib/crypto/keychain';

import type { SignMessageFn } from './sign';

export interface KeychainHandle {
  /** True after the master sign has been completed in this tab session. */
  isUnlocked: boolean;
  /** True while a wallet-popup signMessage call for the master seed is
   *  in flight. Drives the global "open your wallet — sign once" toast
   *  so the user understands what they're being asked to sign (vs. a
   *  confusing unexplained popup). Single-flight: even if N consumers
   *  call `getMasterSeed()` concurrently, this is true exactly once. */
  isUnlocking: boolean;
  /**
   * Force the master-sign prompt now. Idempotent — subsequent calls
   * return the cached seed without re-prompting. Useful when a page
   * wants to surface the prompt eagerly (e.g. on a "My bids" load).
   */
  unlock(): Promise<void>;
  /**
   * Abandon any in-flight signMessage call and re-fire a fresh one.
   * Use this from a real user-gesture handler (button click) to recover
   * from the silent-popup case: when SIWS sign-in pops popup #1 and the
   * keychain prewarm pops popup #2 in the same tick, most wallets
   * (Phantom, Backpack, Solflare) silently swallow popup #2 — it never
   * surfaces because the wallet only allows one popup at a time AND
   * subsequent retries from `unlock()` short-circuit on the still-pending
   * inFlight promise.
   *
   * `forceUnlock()` clears the inFlight gate and calls signMessage again
   * from inside the click handler's user-gesture window, which the
   * wallet treats as a fresh request. The original hung promise's
   * post-await checks for `masterSeedRef.current` so it short-circuits
   * cleanly once the new flow lands the seed; no double-write.
   */
  forceUnlock(): Promise<void>;
  /**
   * Return the cached master seed (or prompt for it). Exposed so
   * helpers in `lib/keychain/enumerate.ts` can derive arbitrary
   * ephemeral indices without holding their own caching state.
   * Stays in tab memory only; never crosses any IO boundary.
   */
  getMasterSeed(): Promise<Uint8Array>;
  /** Derive a slot's 32-byte seed (no Solana keypair construction). */
  slotSeed(role: KeychainRole, suffix: string): Promise<Uint8Array>;
  /** Per-role derived Solana keypair helpers. Each prompts for the
   *  master seed if not yet unlocked, then derives synchronously. */
  buyerEphemeral(index: number): Promise<Keypair>;
  bidderEphemeral(index: number): Promise<Keypair>;
  fundEphemeral(rfpPda: string, seq: number): Promise<Keypair>;
  refundEphemeral(index: number): Promise<Keypair>;
  payoutEphemeral(index: number): Promise<Keypair>;
}

/**
 * Build a KeychainHandle around a wallet's signMessage callback.
 *
 * Caller pattern:
 *
 *   const account = useTendrAccount();
 *   const signMessage = useTendrSignMessage(account!);
 *   const keychain = useKeychain(signMessage);
 *
 *   // Later, anywhere in the same tree:
 *   const eph = await keychain.buyerEphemeral(7);
 *   //   ↑ first call triggers the wallet popup; subsequent silent.
 *
 * Stable across renders — the returned handle's identity is preserved
 * across re-renders so it can be safely included in effect deps without
 * looping.
 */
/** sessionStorage key for the master seed. Per-wallet so a wallet swap
 *  doesn't accidentally hydrate the new wallet from the old wallet's
 *  seed. sessionStorage is per-tab AND survives page reloads — so
 *  hard-refreshing the same tab no longer re-prompts the master sign,
 *  but closing the tab still wipes it (fresh session = fresh popup). */
const SESSION_SEED_KEY = (wallet: string) => `tender:keychain-seed:${wallet}`;

export function useKeychain(signMessage: SignMessageFn, walletAddress?: string): KeychainHandle {
  const [masterSeed, setMasterSeed] = useState<Uint8Array | null>(null);
  // Drives the global unlock toast. Distinct from `isUnlocked` — true
  // ONLY while the wallet popup is awaiting a signature. Single-flight
  // via `inFlightRef` already guarantees this transitions exactly once
  // per logical unlock no matter how many consumers race.
  const [isUnlocking, setIsUnlocking] = useState(false);

  // Hydrate from sessionStorage on mount / wallet swap so a hard reload
  // of an already-unlocked tab doesn't re-prompt the master sign. The
  // seed never persists to localStorage (only sessionStorage), so it's
  // wiped when the tab closes — same threat-window as the prior
  // memory-only model. SignOut wipes this explicitly.
  useEffect(() => {
    if (typeof window === 'undefined' || !walletAddress) return;
    try {
      const raw = window.sessionStorage.getItem(SESSION_SEED_KEY(walletAddress));
      if (!raw) return;
      const seed = base64ToBytes(raw);
      if (seed.length !== 32) return;
      setMasterSeed(seed);
    } catch {
      /* private mode / corrupt entry — fall through */
    }
  }, [walletAddress]);
  // Single-flight the in-progress signMessage call. Without this, two
  // consumers that mount on the same render (e.g. useIsHdBuyer + the
  // your-bid-panel Phase 2 effect, both firing on a hard refresh of a
  // private-bidder RFP page) each see `masterSeed === null` (state
  // hasn't flushed between them) and each call signMessage → wallet
  // shows two popups for the same logical unlock. The ref shares the
  // pending promise so the second caller awaits the first popup
  // instead of triggering its own.
  const inFlightRef = useRef<Promise<Uint8Array> | null>(null);

  // Cross-tab unlock sync. The master seed is intentionally tab-scoped
  // (in-memory only — never persists to localStorage). But "tab-scoped"
  // means a new tab opened from a same-origin link re-prompts the
  // master sign — annoying when the user already unlocked the keychain
  // in tab A and clicks an RFP into tab B. BroadcastChannel sends the
  // seed between same-origin tabs in memory only; we never serialize
  // to disk. Security model is unchanged: an XSS in any tab can read
  // the seed via React context anyway, so cross-tab sharing in memory
  // doesn't escalate any privileges.
  const channelRef = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !walletAddress) return;
    if (typeof BroadcastChannel === 'undefined') return; // older browsers
    const channel = new BroadcastChannel('tender:keychain');
    channelRef.current = channel;
    // Announce ourselves so any tab that's already unlocked can echo
    // their seed back to us. Otherwise the new tab would have to wait
    // for the next active unlock event (which may never happen).
    channel.postMessage({ type: 'request-seed', wallet: walletAddress });
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; wallet?: string; seedB64?: string };
      if (!data || data.wallet !== walletAddress) return;
      if (data.type === 'request-seed' && masterSeedRef.current) {
        // Another tab is asking — broadcast our seed so they hydrate.
        channel.postMessage({
          type: 'seed',
          wallet: walletAddress,
          seedB64: bytesToBase64(masterSeedRef.current),
        });
        return;
      }
      if (data.type === 'seed' && data.seedB64) {
        // Don't overwrite our own seed (already-unlocked tabs shouldn't
        // trust an inbound message over what they derived locally).
        if (masterSeedRef.current) return;
        try {
          const seed = base64ToBytes(data.seedB64);
          if (seed.length !== 32) return;
          // Update the ref FIRST + synchronously, then queue the React
          // state update for the re-render. Without the ref-first write,
          // any caller that awaits `getMasterSeed()` between this
          // handler running and the next render commit (when the
          // `[masterSeed] -> ref` useEffect fires) would still see the
          // ref empty and trigger a redundant signMessage popup. The
          // KeychainProvider's pre-warm timer is the load-bearing
          // caller — without this fix it would race the ref update
          // every time and pop the wallet on every new tab.
          masterSeedRef.current = seed;
          setMasterSeed(seed);
          // Also persist so a hard reload of THIS tab doesn't re-prompt.
          try {
            window.sessionStorage.setItem(SESSION_SEED_KEY(walletAddress), data.seedB64);
          } catch {
            /* private mode — non-fatal */
          }
        } catch {
          /* malformed message — ignore */
        }
      }
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
      channelRef.current = null;
    };
  }, [walletAddress]);

  // Mirror of masterSeed in a ref so the BroadcastChannel callback
  // (which doesn't re-bind on every render) can read the latest value.
  const masterSeedRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    masterSeedRef.current = masterSeed;
  }, [masterSeed]);

  const ensureSeed = useCallback(async (): Promise<Uint8Array> => {
    // Read via ref — not the closured `masterSeed` — so a late-arriving
    // BroadcastChannel hydration that happened AFTER this useCallback
    // was built but BEFORE this call wins the race and we skip the
    // popup. Without this, a consumer holding a slightly stale handle
    // could trigger a redundant signature prompt even though another
    // tab unlocked us a moment ago. (The useCallback dep on `masterSeed`
    // still rebuilds the handle on the next render, but timing-sensitive
    // callers can fire on the previous tick.)
    if (masterSeedRef.current) return masterSeedRef.current;
    if (inFlightRef.current) return inFlightRef.current;
    const promise = (async () => {
      try {
        // Re-check ONE more time inside the microtask — covers the
        // window where setState dispatched + BroadcastChannel hydrated
        // between our gate above and the actual `signMessage` call.
        // ONLY set isUnlocking AFTER this check so a hydration in the
        // microtask gap doesn't briefly flash the unlock toast.
        if (masterSeedRef.current) return masterSeedRef.current;
        setIsUnlocking(true);
        const message = deriveKeychainSeedMessage();
        const { signature } = await signMessage({ message });
        // Final re-check post-await: the popup itself takes seconds, so
        // a sibling tab could finish unlocking + broadcast its seed
        // while we were waiting on the user. Prefer the cross-tab seed
        // (deterministic origin) over the one we just derived; either
        // would work mathematically (same wallet → same signature →
        // same seed) but this avoids racing two writers to setState.
        if (masterSeedRef.current) return masterSeedRef.current;
        const seed = deriveMasterSeed(signature);
        setMasterSeed(seed);
        // Persist for this tab's reload survival.
        if (typeof window !== 'undefined' && walletAddress) {
          try {
            window.sessionStorage.setItem(SESSION_SEED_KEY(walletAddress), bytesToBase64(seed));
          } catch {
            /* private mode — non-fatal */
          }
        }
        // Tell other same-origin tabs about this unlock so a new tab
        // (or one whose seed got cleared) can hydrate without
        // re-prompting the user.
        if (channelRef.current && walletAddress) {
          channelRef.current.postMessage({
            type: 'seed',
            wallet: walletAddress,
            seedB64: bytesToBase64(seed),
          });
        }
        return seed;
      } finally {
        inFlightRef.current = null;
        setIsUnlocking(false);
      }
    })();
    inFlightRef.current = promise;
    return promise;
  }, [signMessage, walletAddress]);

  const unlock = useCallback(async (): Promise<void> => {
    await ensureSeed();
  }, [ensureSeed]);

  const forceUnlock = useCallback(async (): Promise<void> => {
    // Already unlocked — nothing to retry.
    if (masterSeedRef.current) return;
    // Drop the cached in-flight promise so `ensureSeed`'s second-gate
    // (`if (inFlightRef.current) return inFlightRef.current;`) misses
    // and a fresh signMessage request goes out from this click.
    inFlightRef.current = null;
    // Also clear isUnlocking so the toast's pending-state can be
    // re-asserted cleanly inside the new ensureSeed run (it'll set it
    // back to true immediately).
    setIsUnlocking(false);
    await ensureSeed();
  }, [ensureSeed]);

  const slotSeed = useCallback(
    async (role: KeychainRole, suffix: string): Promise<Uint8Array> => {
      const seed = await ensureSeed();
      return deriveSlotSeed(seed, role, suffix);
    },
    [ensureSeed],
  );

  const buyerEphemeral = useCallback(
    async (index: number): Promise<Keypair> => {
      const seed = await ensureSeed();
      return deriveBuyerEphemeral(seed, index);
    },
    [ensureSeed],
  );

  const bidderEphemeral = useCallback(
    async (index: number): Promise<Keypair> => {
      const seed = await ensureSeed();
      return deriveBidderEphemeral(seed, index);
    },
    [ensureSeed],
  );

  const fundEphemeral = useCallback(
    async (rfpPda: string, seq: number): Promise<Keypair> => {
      const seed = await ensureSeed();
      return deriveFundEphemeral(seed, rfpPda, seq);
    },
    [ensureSeed],
  );

  const refundEphemeral = useCallback(
    async (index: number): Promise<Keypair> => {
      const seed = await ensureSeed();
      return deriveRefundEphemeral(seed, index);
    },
    [ensureSeed],
  );

  const payoutEphemeral = useCallback(
    async (index: number): Promise<Keypair> => {
      const seed = await ensureSeed();
      return derivePayoutEphemeral(seed, index);
    },
    [ensureSeed],
  );

  // Memoize the returned handle so its identity is stable across
  // renders. Without this, every consuming component sees a fresh
  // object every render — useEffect deps that include `keychain`
  // would re-fire infinitely (or worse, fire RPC enumerates over
  // and over). The handle's identity changes only when isUnlocked
  // flips OR when one of the derive callbacks rebuilds (which
  // happens only when ensureSeed identity changes — i.e. when
  // masterSeed transitions null → seed).
  const isUnlocked = masterSeed !== null;
  return useMemo(
    () => ({
      isUnlocked,
      isUnlocking,
      unlock,
      forceUnlock,
      getMasterSeed: ensureSeed,
      slotSeed,
      buyerEphemeral,
      bidderEphemeral,
      fundEphemeral,
      refundEphemeral,
      payoutEphemeral,
    }),
    [
      isUnlocked,
      isUnlocking,
      unlock,
      forceUnlock,
      ensureSeed,
      slotSeed,
      buyerEphemeral,
      bidderEphemeral,
      fundEphemeral,
      refundEphemeral,
      payoutEphemeral,
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* base64 helpers — small + browser-only (no Node Buffer dependency).          */
/* Kept inline to avoid pulling in a util module; only ~10 LOC each.           */
/* -------------------------------------------------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Wipe any persisted master seed(s) from sessionStorage. Called by
 * the sign-out flow so a different wallet (or the same one re-signed
 * later) doesn't accidentally inherit the prior session's keychain.
 *
 * Pass `wallet` to wipe a specific wallet only; omit to wipe all
 * tender keychain seeds in this tab.
 */
export function clearKeychainSeed(wallet?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (wallet) {
      window.sessionStorage.removeItem(SESSION_SEED_KEY(wallet));
      return;
    }
    for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith('tender:keychain-seed:')) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode — non-fatal */
  }
}
