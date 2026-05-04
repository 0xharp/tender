'use client';

/**
 * Global provider for the claim-identity modal.
 *
 * Two responsibilities:
 *
 *   1. Owns the single ClaimIdentityModal instance for the app — so any
 *      component (wallet popover, dashboard banner, RFP create form CTA)
 *      can call `openClaimModal()` without each rendering its own copy.
 *   2. Auto-opens the modal once per browser session for any signed-in
 *      wallet that has no `tendr.sol` subdomain claim yet. Suppression
 *      tracked via sessionStorage so a user who dismissed the modal in
 *      one tab doesn't keep getting re-prompted on every navigation in
 *      that same tab; next session will re-prompt if still unclaimed.
 *
 * Auto-trigger gate: SIGNED IN, not just connected. The provider takes a
 * `signedInWallet` prop resolved server-side (SIWS JWT cookie) — without
 * this gate, the modal would auto-open as soon as the wallet adapter
 * connects (step 1 of the connect-then-sign-in flow), stacking on top of
 * the still-open SIWS sign-in dialog.
 *
 * Mount once near the top of the app tree (inside WalletProviders so
 * the imperative `openClaimModal` is reachable from nav components).
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { ClaimIdentityModal } from '@/components/identity/claim-identity-modal';
import { invalidateSnsCache } from '@/lib/sns/cache';
import { useSnsName } from '@/lib/sns/hooks';

const SESSION_DISMISSED_KEY = 'tender:identity:dismissed';

interface IdentityModalContextValue {
  /** Imperatively open the claim modal — used by explicit CTAs. */
  openClaimModal: () => void;
}

const IdentityModalContext = createContext<IdentityModalContextValue | null>(null);

export function useIdentityModal(): IdentityModalContextValue {
  const ctx = useContext(IdentityModalContext);
  if (!ctx) {
    throw new Error('useIdentityModal must be used inside <IdentityModalProvider>');
  }
  return ctx;
}

export function IdentityModalProvider({
  children,
  signedInWallet,
}: {
  children: ReactNode;
  /** Wallet address from the SIWS session JWT (server-resolved). null
   *  when the user is not signed in — modal will not auto-open in that
   *  case. */
  signedInWallet: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Reverse-resolve the SIGNED-IN wallet's tendr identity. Returns:
  //   undefined → still resolving (or not signed in yet)
  //   null      → resolved with no claim
  //   string    → resolved to `<handle>.tendr.sol`
  // biome-ignore lint/suspicious/noExplicitAny: kit Address branding nominal cast
  const subdomainName = useSnsName(signedInWallet as any);
  // Guard so we only auto-open ONCE per session per wallet — without
  // this, every re-render that flips `subdomainName` from undefined →
  // null would re-pop the modal after the user dismissed it.
  const autoOpenedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!signedInWallet) return;
    // `null` = resolved + no claim. `undefined` = still loading.
    if (subdomainName !== null) return;
    // Don't auto-open the same wallet twice in this component lifetime.
    if (autoOpenedFor.current === signedInWallet) return;
    // Don't auto-open if the user dismissed in this browser session.
    if (typeof window !== 'undefined') {
      const dismissed = window.sessionStorage.getItem(SESSION_DISMISSED_KEY);
      if (dismissed === signedInWallet) return;
    }
    autoOpenedFor.current = signedInWallet;
    setOpen(true);
  }, [signedInWallet, subdomainName]);

  const openClaimModal = useCallback(() => {
    setOpen(true);
  }, []);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // If user closed without claiming, persist dismissal for this session
    // so we don't re-pop on the next navigation. A successful claim
    // (`onClaimed` callback fires before close) ALSO closes via this
    // path, but that's fine — they have a claim now, won't be re-prompted.
    if (!next && signedInWallet && typeof window !== 'undefined') {
      window.sessionStorage.setItem(SESSION_DISMISSED_KEY, signedInWallet);
    }
  }

  // Bust the wallet's cached SNS entry the moment a claim lands.
  // Without this, `useSnsName(signedInWallet)` keeps serving the stale
  // negative cache (TTL = 10 min) the hook wrote during the empty-state
  // resolve before the user clicked Claim, so the new name wouldn't
  // appear in the UI until either TTL expiry or a tab reload.
  function handleClaimed(_fullName: string) {
    if (signedInWallet) {
      // biome-ignore lint/suspicious/noExplicitAny: kit Address branding nominal cast
      invalidateSnsCache(signedInWallet as any);
    }
  }

  return (
    <IdentityModalContext.Provider value={{ openClaimModal }}>
      {children}
      <ClaimIdentityModal
        open={open}
        onOpenChange={handleOpenChange}
        onClaimed={handleClaimed}
      />
    </IdentityModalContext.Provider>
  );
}
