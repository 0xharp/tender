'use client';

/**
 * KeychainProvider — app-wide context that holds ONE master-seed
 * derivation per session, shared across every surface that needs to
 * derive HD ephemerals (DiscoverPrivateBids, DiscoverPrivateRfps,
 * BuyerActionPanel's private-fund flow, RfpCreateForm's private-create
 * flow, AttestRfpButton, the bid composer's private-bidder mode, …).
 *
 * Without this provider, each surface independently calls
 * `useKeychain(signMessage)`, and the underlying `getMasterSeed()` is
 * lazy-cached *per-component*. That means the same user clicking
 * "Unlock private bids" then "Fund private" then "Create private RFP"
 * gets THREE separate master-sign popups for the same wallet — wasteful
 * and confusing. With the provider, the keychain handle is a singleton
 * for the tab session: first action triggers one popup, subsequent
 * actions are silent.
 *
 * Mount once in the root layout, inside the wallet provider so
 * `useTendrAccount` resolves. Yields `null` when no wallet is
 * connected, mirroring the rest of the wallet-lib boundary's API.
 *
 * Wallet portability: same as the underlying `useKeychain` hook — uses
 * only `solana:signMessage` from wallet-standard. Works with Phantom,
 * Backpack, Solflare, Nightly, Glow, et al.
 */

import { type ReactNode, createContext, useContext, useEffect } from 'react';
import { toast } from 'sonner';

import { useTendrAccount } from './account';
import { useTendrSignMessage } from './sign';
import { type KeychainHandle, useKeychain } from './use-keychain';

const KeychainContext = createContext<KeychainHandle | null>(null);

export function KeychainProvider({
  children,
  signedInWallet,
}: { children: ReactNode; signedInWallet?: string | null }) {
  const account = useTendrAccount();
  if (!account) {
    // No wallet connected — short-circuit before calling
    // useTendrSignMessage (which requires an account). Children that
    // call `useKeychainContext()` get `null` and should gate their UI
    // on it (typically: "Connect a wallet first").
    return <KeychainContext.Provider value={null}>{children}</KeychainContext.Provider>;
  }
  return (
    <KeychainProviderInner account={account} signedInWallet={signedInWallet ?? null}>
      {children}
    </KeychainProviderInner>
  );
}

function KeychainProviderInner({
  account,
  signedInWallet,
  children,
}: {
  account: import('./account').TendrAccount;
  signedInWallet: string | null;
  children: ReactNode;
}) {
  const signMessage = useTendrSignMessage(account);
  // Scope the cross-tab BroadcastChannel inside useKeychain to this
  // account's address so a wallet swap doesn't accidentally hydrate
  // the new wallet's keychain from the old wallet's seed.
  const keychain = useKeychain(signMessage, account.address);

  // Session-restore pre-warm: when the user has a valid SIWS session
  // (signedInWallet matches the connected account) but the keychain
  // is locked (typical on a fresh tab / hard refresh — masterSeed is
  // tab-scoped in-memory only), auto-trigger the master sign once.
  // Without this, every HD-aware surface (marketplace "mine" badges,
  // private-bid auto-resolve, ephemeral balance panel, my-projects HD
  // entries) would silently render empty until the user navigates to
  // a surface that explicitly prompts.
  //
  // sessionStorage flag prevents re-prompting if the user dismissed
  // (so refresh-spam doesn't loop). Cleared on sign-out (the SIWS
  // sign-out path tears down the session cookie + reloads, which
  // wipes sessionStorage anyway).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keychain handle identity is stable across renders; depending on it would not change behavior
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!signedInWallet || signedInWallet !== account.address) return;
    if (keychain.isUnlocked) return;
    const flagKey = `tender:keychain-prewarmed:${account.address}`;
    if (window.sessionStorage.getItem(flagKey) === '1') return;

    // Race-window for the BroadcastChannel: useKeychain's mount-time
    // `request-seed` broadcast travels to other tabs, gets answered,
    // and lands back here as a `seed` message — but only after THIS
    // tab's listener is attached, the OTHER tab's listener fires + posts
    // back, AND React commits the inbound state update. In production
    // that round trip can stretch past a half second when the page is
    // doing other heavy mount-time work; if we pop the wallet too
    // early we'll surface a redundant signMessage prompt every time the
    // user opens a new tab. 1500ms covers the slow-path comfortably +
    // is still imperceptible if no other tab responds (legitimate first
    // unlock). User can always click any HD-using surface to force the
    // sign earlier if they get tired of waiting.
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      // Another tab might have hydrated us in the meantime.
      if (keychain.isUnlocked) return;
      window.sessionStorage.setItem(flagKey, '1');
      void keychain.getMasterSeed().catch(() => {
        // User dismissed; flag stays set so we don't re-prompt this tab.
      });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signedInWallet, account.address, keychain.isUnlocked]);

  // Global UX surface: as soon as a master-sign popup is in flight,
  // show a sticky toast explaining what the wallet is asking for. Without
  // this, the user sees an unexplained popup mid-action ("why does it
  // want me to sign a message? I just clicked Bid…") and often dismisses
  // it. The toast id is constant so concurrent unlock requests dedupe to
  // a single notification — no double-notification even if N consumers
  // race to call getMasterSeed.
  //
  // Race-safety: we only fire when (a) we're truly locked AND (b) an
  // unlock is in flight. If a BroadcastChannel hydration arrives mid-
  // popup, `isUnlocked` flips true and `isUnlocking` flips false in the
  // same tick — the toast dismisses cleanly without flicker. The toast
  // can NOT trigger a redundant unlock itself; it only observes state.
  useEffect(() => {
    const TOAST_ID = 'tender:keychain-unlock';
    if (!keychain.isUnlocking || keychain.isUnlocked) {
      toast.dismiss(TOAST_ID);
      return;
    }
    toast.message('Sign in your wallet to unlock your private keychain', {
      id: TOAST_ID,
      description:
        'One signature per session — derives the seed for your private RFPs, bids, and ephemeral wallets. No funds move.',
      duration: Number.POSITIVE_INFINITY,
      // Recovery affordance for the silent-popup case: when the SIWS
      // popup and the keychain prewarm popup race, most wallets refuse
      // to surface the second one — the toast appears but the wallet
      // stays quiet. Clicking this button re-fires signMessage from
      // inside a real user-gesture, which the wallet treats as a fresh
      // request. See `forceUnlock` in use-keychain.ts for the gate-clear
      // mechanics that let this short-circuit the in-flight call.
      action: {
        label: 'Unlock now',
        onClick: () => {
          void keychain.forceUnlock();
        },
      },
    });
    return () => {
      toast.dismiss(TOAST_ID);
    };
    // `keychain.forceUnlock` is referenced inside the toast action's
    // onClick. We re-run the effect when the lock-state flags flip
    // (toast appears/dismisses); forceUnlock itself is a stable
    // useCallback so we re-bind the closure on every effect run via
    // its current identity captured here.
  }, [keychain.isUnlocking, keychain.isUnlocked, keychain.forceUnlock]);

  return <KeychainContext.Provider value={keychain}>{children}</KeychainContext.Provider>;
}

/**
 * Read the app-wide keychain handle. Returns `null` if no wallet is
 * connected (parent components should typically check `useTendrAccount`
 * first and short-circuit before calling this — the null branch is just
 * safety against mid-render disconnect events).
 *
 * The handle's `isUnlocked`/`getMasterSeed`/derive helpers are stable
 * across re-renders of the consuming component (see `useKeychain`),
 * so passing them into effect deps doesn't trigger re-runs.
 */
export function useKeychainContext(): KeychainHandle | null {
  return useContext(KeychainContext);
}
