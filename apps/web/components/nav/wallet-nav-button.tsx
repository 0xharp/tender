'use client';

import { NO_ACTIVE_MILESTONE, computeNextAction } from '@/lib/me/next-action';
import {
  type TendrWallet,
  clearKeychainSeed,
  clearMyActivityCache,
  performSignOut,
  useMyActivity,
  useTendrAccount,
  useTendrDisconnect,
  useTendrSelectedAccount,
  useTendrWallets,
} from '@/lib/wallet';
import type { Address } from '@solana/kit';
import {
  GavelIcon,
  LoaderCircleIcon,
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
import { useSnsName } from '@/lib/sns/hooks';
import { cn } from '@/lib/utils';

function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export interface WalletNavButtonProps {
  /** Server-determined signed-in wallet (from session JWT). null if no session. */
  signedInWallet: string | null;
}

export function WalletNavButton({ signedInWallet }: WalletNavButtonProps) {
  // Pre-hydration fallback uses the SSR-known signed-in wallet so a
  // refreshing user doesn't see a confusing "Connect wallet" disabled
  // state for ~200ms before SignedInPopover hydrates. Without this, a
  // user with a valid SIWS cookie momentarily sees their nav as if
  // they're logged out — looks broken even though everything else on
  // the page (mine badges, my-activity, etc.) renders correctly.
  const fallback =
    signedInWallet !== null ? (
      <NavButtonShell label={shortAddress(signedInWallet)} />
    ) : (
      <NavButtonShell label="Connect wallet" />
    );
  return (
    <ClientOnly fallback={fallback}>
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
 * Only fires on a CONCRETE different address (real wallet swap). Does NOT
 * fire on `connected === null`, because that state is ambiguous: it can mean
 * "wallet adapter hasn't reconnected yet on tab open / page mount" (transient,
 * resolves in a few hundred ms) OR "user explicitly clicked Disconnect"
 * (handled separately in the picker / sign-out button). Treating null as a
 * mismatch caused multi-tab and post-action sign-outs.
 *
 * Renders nothing; pure side effect.
 */
function WalletSessionSync({ signedInWallet }: { signedInWallet: string | null }) {
  const account = useTendrAccount();
  const router = useRouter();
  // Throttle: don't fire DELETE on every render - only on actual mismatch transitions.
  const lastSyncedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!signedInWallet) return; // not signed in → nothing to sync
    const connected = account?.address ?? null;
    if (connected === null) return; // wallet not yet reconnected — wait, don't nuke the session
    if (connected === signedInWallet) {
      lastSyncedFor.current = null;
      return;
    }
    // Already synced this exact mismatch - don't re-fire.
    const mismatchKey = `${signedInWallet}::${connected}`;
    if (lastSyncedFor.current === mismatchKey) return;
    lastSyncedFor.current = mismatchKey;

    void performSignOut().then(() => router.refresh());
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
  const baseActionCount = useActionCount({ wallet, pollMs: 60_000, refetchOnOpen: open });
  // HD-derived action count from MyActivityProvider — the server-side
  // useActionCount only knows about main-wallet activity. For HD-buyer
  // RFPs in `reveal` / `bidsclosed` / `awarded` (any state where the
  // buyer must act next), bump the badge so the user sees the dot.
  const hdActionCount = useHdActionCount(wallet);
  const actionCount = baseActionCount + hdActionCount;
  // While the central activity feed is enumerating (initial load OR a
  // post-mutation refresh), surface a tiny spinner near the badge so
  // the user understands the count may still be settling.
  const myActivity = useMyActivity();
  const syncing = myActivity.isLoading;
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
            {/* Syncing indicator — visible while MyActivity enumerate is
                in flight (initial load OR after a refresh trigger). The
                badge count may still be settling; the spinner tells the
                user the number is provisional and not stale. */}
            {syncing && (
              <LoaderCircleIcon
                aria-label="Syncing your projects + bids…"
                className="size-3 animate-spin text-muted-foreground"
              />
            )}
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
          {/* Dashboard now consolidates everything: stats, reputation,
              ephemerals, buying + bidding tabs with action highlights. */}
          <PopoverItem
            icon={UserIcon}
            href="/dashboard"
            label="Dashboard"
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
 *
 * Cached in localStorage per-wallet so a returning user lands with the
 * right number on the very first paint (no 0 → 1 flicker that combines
 * with the HD action count to render a misleading intermediate "2"
 * before settling on "3").
 */
const ACTION_COUNT_CACHE_KEY = (wallet: string) => `tender:action-count:${wallet}`;

function useActionCount({
  wallet,
  pollMs,
  refetchOnOpen,
}: {
  wallet: string;
  pollMs: number;
  refetchOnOpen: boolean;
}): number {
  // Hydrate from localStorage on mount (same pattern as MyActivity).
  // Pure useEffect — never useState initializer — to keep SSR/CSR
  // hydration in sync.
  const [count, setCount] = useState(0);
  const refetch = useRef<() => void>(() => {});

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(ACTION_COUNT_CACHE_KEY(wallet));
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) setCount(parsed);
      }
    } catch {
      /* private mode — fall through, fetch will set the real value */
    }
  }, [wallet]);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await fetch('/api/me/action-count', { cache: 'no-store' });
        if (!res.ok) return;
        const j = (await res.json()) as { count?: number };
        if (!cancelled && typeof j.count === 'number') {
          setCount(j.count);
          try {
            window.localStorage.setItem(ACTION_COUNT_CACHE_KEY(wallet), String(j.count));
          } catch {
            /* quota — non-fatal */
          }
        }
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
  }, [pollMs, wallet]);

  // Refetch when popover opens (catches state changes from in-flight action).
  useEffect(() => {
    if (refetchOnOpen) refetch.current();
  }, [refetchOnOpen]);

  // Also refetch on the central activity refresh signal so when a flow
  // calls `triggerActivityRefresh()` after a tx confirms, the badge
  // updates immediately instead of waiting for the next 60s poll tick.
  // Same event MyActivityProvider listens to.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onRefresh = () => refetch.current();
    window.addEventListener('tender:refresh-activity', onRefresh);
    return () => window.removeEventListener('tender:refresh-activity', onRefresh);
  }, []);

  return count;
}

/**
 * Count HD-buyer RFPs + HD-bidder bids whose status implies the user
 * needs to act. Both sides are invisible to the server-side
 * /api/me/action-count (which only knows the main wallet's bids/RFPs)
 * because HD activity is signed by ephemeral wallets.
 *
 * Buyer side: re-runs `computeNextAction` here with role='buyer' from
 * MyActivity's per-RFP chain snapshot. Conservative on funded/inprogress
 * (no per-RFP milestone fetch in the badge — the page does that) so the
 * badge over-notifies rather than under-notifies a delivered milestone.
 *
 * Bidder side: reads `nextActionUrgency` already pre-computed by the
 * activity provider's enrichment pass (with the full milestones array,
 * so it's precise). Catches private-mode wins where the provider must
 * `start_milestone` / `submit_milestone` next — the action that was
 * silently missing from the badge before.
 */
function useHdActionCount(connectedWallet: string): number {
  const account = useTendrAccount();
  const activity = useMyActivity();
  if (!account || account.address !== connectedWallet) return 0;
  if (!activity.isReady) return 0;
  const now = Date.now();
  const buyerCount = activity.ownedRfps.filter((r) => {
    if (r.via !== 'hd') return false;
    const a = computeNextAction({
      role: 'buyer',
      status: r.status,
      activeMilestoneIndex: r.activeMilestoneIndex ?? NO_ACTIVE_MILESTONE,
      milestones: [], // badge stays fast — page does the precise per-RFP fetch
      bidCloseAtMs: r.bidCloseAtMs,
      revealCloseAtMs: r.revealCloseAtMs,
      fundingDeadlineMs: r.fundingDeadlineMs ?? null,
      nowMs: now,
      bidCount: r.bidCount,
    });
    return a.urgency === 'now';
  }).length;
  const bidderCount = activity.ownBids.filter(
    (b) => b.via === 'hd' && b.nextActionUrgency === 'now',
  ).length;
  return buyerCount + bidderCount;
}

function SignOutItem({ onAfter }: { onAfter: () => void }) {
  const [busy, setBusy] = useState(false);
  const account = useTendrAccount();
  const wallets = useTendrWallets();
  const { setAccount } = useTendrSelectedAccount();
  // useTendrDisconnect requires a wallet handle. Find the wallet that
  // owns the currently-selected account so we can fully disconnect on
  // sign-out (not just clear the SIWS cookie). Without this, the
  // wallet adapter stays connected, and SignInGate immediately shows
  // the SignInButton ready-to-go — which feels like a half-sign-out.
  const wallet = account
    ? wallets.find((w) => w.accounts.some((a) => a.address === account.address))
    : undefined;
  const [, disconnect] = useTendrDisconnect(wallet ?? ({} as TendrWallet));

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // Disconnect the wallet adapter first so the post-signout
          // page renders the "Connect wallet" trigger (not the
          // already-connected "Sign in" trigger). Best-effort — if the
          // wallet errors mid-disconnect, the sign-out still proceeds.
          if (wallet) {
            try {
              await disconnect();
            } catch {
              /* ignore — extension uninstalled / already disconnected */
            }
          }
          setAccount(undefined);
          await performSignOut();
          // Mark "just signed out" so SignInGate's auto-trigger
          // doesn't immediately fire SIWS again — and clear the
          // keychain pre-warm flag + cached activity so a different
          // wallet (or the same one re-signed-in later) doesn't see
          // the prior session's data.
          if (typeof window !== 'undefined') {
            try {
              window.sessionStorage.setItem('tender:just-signed-out', '1');
              window.sessionStorage.removeItem('tender:wallet-connect-intent');
              for (let i = window.sessionStorage.length - 1; i >= 0; i--) {
                const key = window.sessionStorage.key(i);
                if (key?.startsWith('tender:keychain-prewarmed:')) {
                  window.sessionStorage.removeItem(key);
                }
              }
            } catch {
              /* private mode / quota — non-fatal */
            }
          }
          clearMyActivityCache();
          clearKeychainSeed();
          // Best-effort wipe of the action-count cache too so a
          // different wallet doesn't briefly inherit the prior count.
          if (typeof window !== 'undefined') {
            try {
              for (let i = window.localStorage.length - 1; i >= 0; i--) {
                const key = window.localStorage.key(i);
                if (key?.startsWith('tender:action-count:')) {
                  window.localStorage.removeItem(key);
                }
              }
            } catch {
              /* private mode — non-fatal */
            }
          }
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
  const account = useTendrAccount();
  const router = useRouter();

  // Three states for the trigger button:
  //   - no wallet selected → "Connect wallet" (kicks off the picker step)
  //   - wallet selected but not signed in → "Sign in" (skips straight to SIWS)
  //   - signed in → not rendered here (SignedInPopover instead)
  const isConnectedButUnauthed = account != null;
  const buttonLabel = isConnectedButUnauthed ? 'Sign in' : 'Connect wallet';

  // Auto-open the modal when the user JUST clicked our trigger and
  // the wallet finished connecting. We gate on a session-scoped
  // intent flag so the wallet adapter's auto-reconnect on page load
  // (Phantom remembering the prior tab's connection) doesn't pop
  // the modal unsolicited.
  //
  // Flow: trigger click sets the intent flag → user picks a wallet →
  // wallet adapter confirms → account flips undefined → defined →
  // this effect sees the intent flag + transition → opens the modal.
  // Hard reload after sign-out: account auto-reconnects but no
  // intent flag was set → effect is a no-op → user sees the
  // "Connect wallet" trigger as expected.
  const prevAccountRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevAccountRef.current;
    const curr = account?.address;
    prevAccountRef.current = curr;
    if (prev === undefined && curr !== undefined) {
      // Did the user actively initiate this connection?
      let intent = false;
      try {
        intent = window.sessionStorage.getItem('tender:wallet-connect-intent') === '1';
        if (intent) window.sessionStorage.removeItem('tender:wallet-connect-intent');
      } catch {
        /* private mode — fall through, won't auto-open */
      }
      if (intent) setOpen(true);
    }
  }, [account?.address]);

  // Set the intent flag the moment the trigger is clicked. A custom
  // onClick on DialogTrigger is awkward to intercept (Base UI's
  // render-prop spreads its own handlers); instead we wrap the open
  // setter so the flag is set before the dialog opens.
  const openWithIntent = (next: boolean) => {
    if (next) {
      try {
        window.sessionStorage.setItem('tender:wallet-connect-intent', '1');
      } catch {
        /* private mode — non-fatal; modal still opens */
      }
    }
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={openWithIntent}>
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
  const account = useTendrAccount();

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
