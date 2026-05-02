'use client';

import { useSelectedWalletAccount } from '@solana/react';
import { LockKeyholeIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { ClientOnly } from '@/components/client-only';
import { SectionHeader } from '@/components/primitives/section-header';
import { SignInButton } from '@/components/wallet/sign-in-button';
import { WalletPicker } from '@/components/wallet/wallet-picker';
import { cn } from '@/lib/utils';

export function SignInGate() {
  return (
    <main className="relative isolate mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-16 sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-20 left-1/2 -z-10 size-[420px] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
      />

      <SectionHeader
        eyebrow="Authentication"
        title={
          <span className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary">
              <LockKeyholeIcon className="size-4" />
            </span>
            Sign in to tendr.bid
          </span>
        }
        description="Connect a Solana wallet, then sign a one-time message to authorize a 24-hour session. No funds move."
        size="sm"
      />

      <ClientOnly
        fallback={
          <div className="rounded-2xl border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
            Loading wallets…
          </div>
        }
      >
        <GateInner />
      </ClientOnly>
    </main>
  );
}

function GateInner() {
  const [account] = useSelectedWalletAccount();
  const router = useRouter();

  return (
    <div className="flex flex-col gap-4">
      <Step n={1} title="Connect wallet" complete={!!account}>
        <WalletPicker />
      </Step>

      <Step n={2} title="Sign in with Solana" complete={false} dimmed={!account}>
        {account ? (
          <SignInButton account={account} onSignedIn={() => router.refresh()} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Pick a wallet above. The signature is local - no funds move.
          </p>
        )}
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  complete,
  dimmed,
  children,
}: {
  n: number;
  title: string;
  complete?: boolean;
  dimmed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-2xl border p-5 backdrop-blur-sm transition-all',
        dimmed
          ? 'border-dashed border-border/40 bg-muted/20 opacity-70'
          : 'border-border/60 bg-card/50',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-6 items-center justify-center rounded-full border font-mono text-[11px] tabular-nums transition-colors',
            complete
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'border-border bg-card text-muted-foreground',
          )}
        >
          {complete ? '✓' : n}
        </span>
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </p>
      </div>
      {children}
    </section>
  );
}
