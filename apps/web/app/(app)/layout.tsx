import Link from 'next/link';
import type { ReactNode } from 'react';

import { SignInGate } from '@/components/wallet/sign-in-gate';
import { SignOutButton } from '@/components/wallet/sign-out-button';
import { getCurrentWallet } from '@/lib/auth/session';

function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default async function AppLayout({ children }: { children: ReactNode }) {
  const wallet = await getCurrentWallet();

  if (!wallet) {
    return <SignInGate />;
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/rfps" className="font-semibold tracking-tight">
              Tender
            </Link>
            <Link
              href="/rfps"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              RFPs
            </Link>
            <Link
              href="/rfps/new"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              New RFP
            </Link>
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="rounded-md bg-card px-2 py-1 font-mono text-xs">
              {shortAddress(wallet)}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
