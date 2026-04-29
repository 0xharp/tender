'use client';

import { useSelectedWalletAccount } from '@solana/react';
import { LogOutIcon, UserIcon, Wallet2Icon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { ClientOnly } from '@/components/client-only';
import { HashLink } from '@/components/primitives/hash-link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SignInButton } from '@/components/wallet/sign-in-button';
import { WalletPicker } from '@/components/wallet/wallet-picker';
import { cn } from '@/lib/utils';

function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export interface WalletNavButtonProps {
  /** Server-determined signed-in wallet (from session JWT). null if no session. */
  signedInWallet: string | null;
}

export function WalletNavButton({ signedInWallet }: WalletNavButtonProps) {
  return (
    <ClientOnly fallback={<NavButtonShell label="Connect wallet" />}>
      {signedInWallet === null ? (
        <ConnectWalletModal />
      ) : (
        <SignedInPopover wallet={signedInWallet} />
      )}
    </ClientOnly>
  );
}

function NavButtonShell({ label, className }: { label: string; className?: string }) {
  return (
    <Button variant="default" size="sm" className={cn('gap-2 rounded-full', className)} disabled>
      <Wallet2Icon className="size-3.5" />
      {label}
    </Button>
  );
}

/* ------------------------------------------------------------------------- */
/* Signed-in: compact popover anchored to the wallet pill.                    */
/* ------------------------------------------------------------------------- */

function SignedInPopover({ wallet }: { wallet: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            variant="outline"
            size="sm"
            className="gap-2 rounded-full border-border bg-card/60 px-3 font-mono text-xs backdrop-blur-sm hover:bg-card"
          >
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60" />
            {shortAddress(wallet)}
          </Button>
        )}
      />
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-72 rounded-2xl border border-border/60 bg-card/95 p-2 shadow-xl backdrop-blur-xl"
      >
        <div className="flex flex-col gap-2 rounded-xl bg-muted/40 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Connected wallet
          </p>
          <HashLink hash={wallet} kind="account" visibleChars={6} />
        </div>

        <nav className="mt-1 flex flex-col">
          <PopoverItem
            icon={UserIcon}
            href="/dashboard"
            label="Dashboard"
            onNavigate={() => setOpen(false)}
          />
          <PopoverItem
            icon={Wallet2Icon}
            href={`/providers/${wallet}`}
            label="Your provider profile"
            onNavigate={() => setOpen(false)}
          />
          <SignOutItem
            onAfter={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </nav>
      </PopoverContent>
    </Popover>
  );
}

function PopoverItem({
  icon: Icon,
  href,
  label,
  onNavigate,
}: {
  icon: typeof UserIcon;
  href: string;
  label: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted/60"
    >
      <Icon className="size-4 text-muted-foreground" />
      {label}
    </Link>
  );
}

function SignOutItem({ onAfter }: { onAfter: () => void }) {
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/auth/siws', { method: 'DELETE' });
        } finally {
          onAfter();
          setBusy(false);
        }
      }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
    >
      <LogOutIcon className="size-4" />
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/* ------------------------------------------------------------------------- */
/* Not signed in: centered modal for picker + 2-step sign-in flow.            */
/* ------------------------------------------------------------------------- */

function ConnectWalletModal() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={(props) => (
          <Button
            {...props}
            variant="default"
            size="sm"
            className="gap-2 rounded-full bg-primary px-4 text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90"
          >
            <Wallet2Icon className="size-3.5" />
            Connect wallet
          </Button>
        )}
      />
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>Sign in to Tender</DialogTitle>
          <DialogDescription>
            Connect a Solana wallet, then sign a one-time message to authorize a session. No funds
            move.
          </DialogDescription>
        </DialogHeader>
        <ConnectFlow
          onSignedIn={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConnectFlow({ onSignedIn }: { onSignedIn: () => void }) {
  const [account] = useSelectedWalletAccount();

  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card/50 p-4 backdrop-blur-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          1 · Connect wallet
        </p>
        <WalletPicker />
      </section>

      <section
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 backdrop-blur-sm transition-colors',
          account
            ? 'border-border bg-card/50'
            : 'border-dashed border-border/60 bg-muted/30',
        )}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          2 · Sign in with Solana
        </p>
        {account ? (
          <SignInButton account={account} onSignedIn={onSignedIn} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Pick a wallet above. The signature is local — no funds move.
          </p>
        )}
      </section>
    </>
  );
}
