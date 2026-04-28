'use client';

import { useSelectedWalletAccount } from '@solana/react';
import { useRouter } from 'next/navigation';

import { ClientOnly } from '@/components/client-only';
import { SignInButton } from '@/components/wallet/sign-in-button';
import { WalletPicker } from '@/components/wallet/wallet-picker';

/**
 * Full-page gate shown by `(app)/layout.tsx` when no session cookie exists.
 *
 * Step 1: connect a Solana wallet.
 * Step 2: sign the SIWS message → server verifies + sets session cookie.
 * After success, refresh the route — the layout's `getCurrentWallet()` now
 * returns a wallet and renders the actual app.
 */
export function SignInGate() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold">Sign in to Tender</h1>
        <p className="text-sm text-muted-foreground">
          Connect a Solana wallet, then sign a one-time message to authorize a session.
        </p>
      </div>

      <ClientOnly fallback={<p className="text-sm text-muted-foreground">Loading wallet…</p>}>
        <GateInner />
      </ClientOnly>
    </main>
  );
}

function GateInner() {
  const [account] = useSelectedWalletAccount();
  const router = useRouter();

  return (
    <div className="flex w-full flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">1. Connect wallet</p>
        <WalletPicker />
      </section>
      {account && (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <p className="text-xs uppercase tracking-widest text-muted-foreground">
            2. Sign in with Solana
          </p>
          <SignInButton account={account} onSignedIn={() => router.refresh()} />
        </section>
      )}
    </div>
  );
}
