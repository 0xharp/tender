'use client';

/**
 * The "Sign in with Solana" button. UI-only — all SIWS logic (message
 * construction, wallet signing, server POST) lives in `lib/wallet/siws.ts`
 * so this component stays a thin presentation surface and the SIWS flow
 * can be re-used by other surfaces (e.g., re-auth on session expiry,
 * deep-link landing) without copying logic.
 *
 * Sign-in goes through `useTendrSignMessage` rather than the native
 * `useSignIn` hook — see lib/wallet/siws.ts for the WHY (Jupiter and
 * Nightly don't implement `solana:signIn`).
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  type TendrAccount,
  performSiwsSignIn,
  useKeychainContext,
  useTendrSignMessage,
} from '@/lib/wallet';

export function SignInButton({
  account,
  onSignedIn,
}: {
  account: TendrAccount;
  onSignedIn?: (wallet: string) => void;
}) {
  const signMessage = useTendrSignMessage(account);
  const keychain = useKeychainContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      const { wallet } = await performSiwsSignIn({ account, signMessage });
      // Fire-and-forget the HD keychain pre-warm. We deliberately do
      // NOT await it — some wallets only show one popup at a time and
      // the second `signMessage` can hang silently if the first popup
      // was a SIWS modal. Sign-in completes the moment SIWS resolves;
      // the keychain prompt continues in the background. If the user
      // dismisses or it never fires, the per-surface "Unlock" CTAs
      // remain the fallback path. (Don't put this AFTER onSignedIn
      // either — onSignedIn typically navigates and unmounts us, and
      // promises started after that may get cancelled by some wallet
      // UIs when the requesting tab transitions.)
      void keychain?.getMasterSeed().catch(() => {
        /* user cancelled keychain sign — fall back to per-surface unlock */
      });
      onSignedIn?.(wallet);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        onClick={handleSignIn}
        disabled={busy}
        className="h-10 w-full rounded-full px-6 shadow-md shadow-primary/25 sm:w-fit"
      >
        {busy ? 'Signing in…' : 'Sign in with Solana'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
