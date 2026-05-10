'use client';

/**
 * AutoSignIn — auto-fires SIWS the moment a wallet connects.
 *
 * Used in two places:
 *   - SignInGate (under the (app) layout) — gates protected routes;
 *     auto-trigger means landing on /me/projects after connecting
 *     just needs the SIWS popup, not an extra "Sign in" button click.
 *   - ConnectWalletModal in the top nav — same intent on public routes
 *     (home, marketplace) so the user doesn't have to click "Connect"
 *     then "Sign in" as two separate steps.
 *
 * Skip cases:
 *   - User just signed out this navigation (sessionStorage flag set
 *     by SignOutItem). Re-firing immediately would be hostile.
 *   - User dismissed an earlier auto-trigger this mount (triedRef).
 *
 * Renders the manual SignInButton as a fallback when auto-trigger
 * is unavailable or failed — user can always click to retry.
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { SignInButton } from '@/components/wallet/sign-in-button';
import {
  type TendrAccount,
  performSiwsSignIn,
  useKeychainContext,
  useTendrSignMessage,
} from '@/lib/wallet';

export interface AutoSignInProps {
  account: TendrAccount;
  onSignedIn: (wallet: string) => void;
}

export function AutoSignIn({ account, onSignedIn }: AutoSignInProps) {
  const signMessage = useTendrSignMessage(account);
  const keychain = useKeychainContext();
  const triedRef = useRef(false);

  useEffect(() => {
    if (triedRef.current) return;
    if (typeof window !== 'undefined') {
      try {
        if (window.sessionStorage.getItem('tender:just-signed-out') === '1') {
          window.sessionStorage.removeItem('tender:just-signed-out');
          triedRef.current = true;
          return;
        }
      } catch {
        /* private mode — fall through */
      }
    }
    triedRef.current = true;
    void (async () => {
      try {
        const { wallet } = await performSiwsSignIn({ account, signMessage });
        // Fire-and-forget keychain pre-warm so private surfaces work
        // immediately on the next navigation.
        void keychain?.getMasterSeed().catch(() => {
          /* user cancelled keychain sign */
        });
        onSignedIn(wallet);
      } catch (e) {
        toast.error('Sign-in failed', { description: (e as Error).message });
        triedRef.current = false;
      }
    })();
  }, [account, signMessage, keychain, onSignedIn]);

  // Manual fallback button always renders — covers dismissal + lets
  // the user retry without page navigation.
  return <SignInButton account={account} onSignedIn={onSignedIn} />;
}
