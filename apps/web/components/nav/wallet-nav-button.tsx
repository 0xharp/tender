'use client';

import type { Address } from '@solana/kit';
import { useSelectedWalletAccount } from '@solana/react';
import {
  GavelIcon,
  ListChecksIcon,
  LogOutIcon,
  ScrollTextIcon,
  SparklesIcon,
  UserIcon,
  Wallet2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { ClientOnly } from '@/components/client-only';
import { useIdentityModal } from '@/components/identity/identity-modal-provider';
import { HashLink } from '@/components/primitives/hash-link';
import { useSnsName } from '@/lib/sns/hooks';
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
      <WalletSessionSync signedInWallet={signedInWallet} />
      {signedInWallet === null ? (
        <ConnectWalletModal />
      ) : (
        <SignedInPopover wallet={signedInWallet} />
      )}
    </ClientOnly>
  );
}

/**
 * Detects when the wallet selected in the extension diverges from the wallet
 * the SIWS session was minted for, and clears the session cookie so the user
 * gets prompted to sign in again with the new wallet. Without this, RLS-gated
 * reads/writes silently fail because the JWT sub no longer matches the wallet
 * doing the action - confusing both for the user and for our analytics.
 *
 * Renders nothing; pure side effect.
 */
function WalletSessionSync({ signedInWallet }: { signedInWallet: string | null }) {
  const [account] = useSelectedWalletAccount();
  const router = useRouter();
  // Throttle: don't fire DELETE on every render - only on actual mismatch transitions.
  const lastSyncedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!signedInWallet) return; // not signed in → nothing to sync
    const connected = account?.address ?? null;
    // Match: nothing to do.
    if (connected === signedInWallet) {
      lastSyncedFor.current = null;
      return;
    }
    // Already synced this exact mismatch - don't re-fire.
    const mismatchKey = `${signedInWallet}::${connected ?? 'disconnected'}`;
    if (lastSyncedFor.current === mismatchKey) return;
    lastSyncedFor.current = mismatchKey;

    // Wallet swapped (or disconnected) without signing out - nuke the session.
    void fetch('/api/auth/siws', { method: 'DELETE' }).then(() => router.refresh());
  }, [account, signedInWallet, router]);

  return null;
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
  const actionCount = useActionCount({ pollMs: 60_000, refetchOnOpen: open });
  const { openClaimModal } = useIdentityModal();
  // Reverse-resolve to .tendr.sol so the navbar trigger label matches the
  // brand identity shown everywhere else. Falls back to truncated hash
  // when the wallet hasn't claimed a tendr identity yet.
  const snsName = useSnsName(wallet as Address);
  const triggerLabel = snsName ?? shortAddress(wallet);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(props) => (
          <Button
            {...props}
            variant="outline"
            size="sm"
            className={cn(
              'gap-2 rounded-full border-border bg-card/60 px-3 font-mono text-xs backdrop-blur-sm hover:bg-card',
              actionCount > 0 && 'border-amber-500/50 bg-amber-500/5',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full shadow-[0_0_8px]',
                actionCount > 0
                  ? 'bg-amber-400 shadow-amber-400/60'
                  : 'bg-emerald-500 shadow-emerald-500/60',
              )}
            />
            <span title={wallet}>{triggerLabel}</span>
            {/* Numbered pip - only renders when at least one project needs
                action. Sized to fit single + double digits without reflow. */}
            {actionCount > 0 && (
              <span
                aria-label={`${actionCount} ${actionCount === 1 ? 'project needs' : 'projects need'} your attention`}
                className="-mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 font-display text-[10px] font-semibold text-amber-50 tabular-nums"
              >
                {actionCount > 99 ? '99+' : actionCount}
              </span>
            )}
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
          <HashLink hash={wallet} kind="account" visibleChars={6} withSns />
        </div>

        <nav className="mt-1 flex flex-col">
          <PopoverItem
            icon={UserIcon}
            href="/dashboard"
            label="Dashboard"
            onNavigate={() => setOpen(false)}
          />
          {/* Operational workbench - every project where this wallet is buyer
              or winning provider, with the next concrete step surfaced. The
              place to start when you log in to actually do something (vs.
              dashboard which is overview / share-card). */}
          <PopoverItem
            icon={ListChecksIcon}
            href="/me/projects"
            label="Your projects"
            badge={actionCount > 0 ? actionCount : undefined}
            onNavigate={() => setOpen(false)}
          />
          {/* Show BOTH role profiles for layout consistency. A wallet that
              hasn't acted in a role yet still has a destination to inspect
              its zero-state - cleaner than asymmetric "provider profile but
              no buyer profile" linkage. */}
          {/* Profile URLs prefer the .sol name when set so the address bar
              stays readable (and shareable). Both routes also accept raw
              pubkeys; .sol just looks better. Falls back to pubkey when
              the wallet has no primary domain. */}
          <PopoverItem
            icon={GavelIcon}
            href={`/providers/${snsName ?? wallet}`}
            label="Your provider profile"
            onNavigate={() => setOpen(false)}
          />
          <PopoverItem
            icon={ScrollTextIcon}
            href={`/buyers/${snsName ?? wallet}`}
            label="Your buyer profile"
            onNavigate={() => setOpen(false)}
          />
          {/* Show "Claim tendr identity" only when this wallet hasn't
              claimed yet. snsName === null after the resolver returns
              with no hit; undefined while loading (don't render then to
              avoid flicker). Hides automatically once claimed. */}
          {snsName === null && (
            <ClaimIdentityItem
              onClick={() => {
                setOpen(false);
                openClaimModal();
              }}
            />
          )}
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
  badge,
  onNavigate,
}: {
  icon: typeof UserIcon;
  href: string;
  label: string;
  /** Numbered pill rendered after the label - used for the "Your projects"
   *  needs-attention count. Hidden when undefined or 0. */
  badge?: number;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted/60"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 font-display text-[10px] font-semibold text-amber-700 tabular-nums dark:text-amber-300">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}

/**
 * Button-shaped popover item — same visual as `PopoverItem` but triggers
 * an `onClick` callback (vs. navigating). Used for the "Claim tendr
 * identity" CTA which opens the global modal rather than a page route.
 * Sparkle icon + primary tint signals "this is special / take action".
 */
function ClaimIdentityItem({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-primary transition-colors hover:bg-primary/10"
    >
      <SparklesIcon className="size-4" />
      <span className="flex-1">Claim tendr identity</span>
    </button>
  );
}

/**
 * Polls the `/api/me/action-count` endpoint to keep the nav badge fresh.
 * Refetches when the popover opens (so the badge reflects an in-flight action
 * the user just took without waiting up to a minute).
 *
 * Returns 0 on any error - the badge is a UX nicety, not a correctness gate.
 */
function useActionCount({
  pollMs,
  refetchOnOpen,
}: {
  pollMs: number;
  refetchOnOpen: boolean;
}): number {
  const [count, setCount] = useState(0);
  const refetch = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await fetch('/api/me/action-count', { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as { count?: number };
        if (!cancelled && typeof j.count === 'number') setCount(j.count);
      } catch {
        // swallow - badge is non-load-bearing
      }
    };
    refetch.current = fetchCount;
    void fetchCount();
    const id = setInterval(fetchCount, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  // Refetch when popover opens (catches state changes from in-flight action).
  useEffect(() => {
    if (refetchOnOpen) refetch.current();
  }, [refetchOnOpen]);

  return count;
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
  const [account] = useSelectedWalletAccount();
  const router = useRouter();

  // Three states for the trigger button:
  //   - no wallet selected → "Connect wallet" (kicks off the picker step)
  //   - wallet selected but not signed in → "Sign in" (skips straight to SIWS)
  //   - signed in → not rendered here (SignedInPopover instead)
  const isConnectedButUnauthed = account != null;
  const buttonLabel = isConnectedButUnauthed ? 'Sign in' : 'Connect wallet';

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
            {buttonLabel}
            {isConnectedButUnauthed && (
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-amber-300 shadow-[0_0_8px] shadow-amber-300/60"
              />
            )}
          </Button>
        )}
      />
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <DialogTitle>Sign in to tendr.bid</DialogTitle>
          <DialogDescription>
            {isConnectedButUnauthed
              ? 'Sign a one-time message to authorize a session for this wallet. No funds move.'
              : 'Connect a Solana wallet, then sign a one-time message to authorize a session. No funds move.'}
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
          account ? 'border-border bg-card/50' : 'border-dashed border-border/60 bg-muted/30',
        )}
      >
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          2 · Sign in with Solana
        </p>
        {account ? (
          <SignInButton account={account} onSignedIn={onSignedIn} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Pick a wallet above. The signature is local - no funds move.
          </p>
        )}
      </section>
    </>
  );
}
