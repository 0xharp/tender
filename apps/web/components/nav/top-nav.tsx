import Link from 'next/link';

import { MobileNav } from '@/components/nav/mobile-nav';
import { NavLinks } from '@/components/nav/nav-links';
import { ThemeToggle } from '@/components/nav/theme-toggle';
import { WalletNavButton } from '@/components/nav/wallet-nav-button';
import { getCurrentWallet } from '@/lib/auth/session';

import { TendrMark } from './tendr-mark';

export async function TopNav() {
  const wallet = await getCurrentWallet();
  const signedIn = wallet !== null;

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 shadow-sm shadow-foreground/[0.03] backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="group flex items-center gap-2 text-foreground transition-colors"
            aria-label="tendr.bid - home"
          >
            <TendrMark className="size-6 text-primary transition-transform group-hover:scale-110" />
            <span className="font-display text-base font-semibold tracking-tight">tendr.bid</span>
          </Link>
          <NavLinks signedIn={signedIn} />
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <WalletNavButton signedInWallet={wallet} />
          <MobileNav signedIn={signedIn} />
        </div>
      </div>
    </header>
  );
}
