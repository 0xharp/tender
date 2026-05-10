import type { Address } from '@solana/kit';
import { ArrowUpRightIcon, FileTextIcon, GavelIcon, TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MyActivityCount } from '@/components/dashboard/my-activity-count';
import { DashboardSyncIndicator } from '@/components/dashboard/sync-indicator';
import { EphemeralManager } from '@/components/profile/ephemeral-manager';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { listProjectsForWallet } from '@/lib/me/projects';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  fetchBuyerReputation,
  fetchProviderReputation,
  listBids,
  listRfps,
  microUsdcToDecimal,
} from '@/lib/solana/chain-reads';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const wallet = (await getCurrentWallet()) as string;

  // On-chain reads - single source of truth. The "bids you've committed"
  // count covers PUBLIC-mode bids only: bid.provider == this wallet. Private
  // bids are signed by per-RFP ephemeral keypairs and are intentionally not
  // enumerable from the main wallet (that's the privacy property).
  const walletAddr = wallet as Address;
  // Reputation reads are issued in parallel with the listings so the page
  // load stays a single round-trip. Both rep accounts are nullable - a wallet
  // that has never awarded an RFP has no BuyerReputation; one that has never
  // won has no ProviderReputation. UI renders a quiet empty state in either
  // case rather than zeroes (which would imply "active but with zero stats").
  const [myRfps, ownBids, buyerRep, providerRep, profileSlug, projects] = await Promise.all([
    // Only the wallet's own RFPs (memcmp-filtered) — we no longer need
    // the full marketplace listing here since the "Open marketplace
    // RFPs" stat was dropped from the header.
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
    fetchBuyerReputation(walletAddr),
    fetchProviderReputation(walletAddr),
    // Prefer the connected wallet's .sol name in profile-link URLs so
    // hovering "your provider profile →" shows /providers/sharpre.sol
    // not /providers/CRZUd…1JYv. Falls back to pubkey if no primary set.
    preferredProfileSlug(wallet),
    // Authoritative actionable counts per side — same source the wallet
    // pill consumes via /api/me/action-count, so the two surfaces
    // never diverge. HD additions stack on top inside MyActivityCount.
    listProjectsForWallet(walletAddr),
  ]);

  const rfpsPosted = myRfps.length;
  const bidsCommitted = ownBids.length;
  const buyerActionable = projects.filter(
    (r) => r.role === 'buyer' && r.nextAction.urgency === 'now',
  ).length;
  const providerActionable = projects.filter(
    (r) => r.role === 'provider' && r.nextAction.urgency === 'now',
  ).length;

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    {
      href: '/dashboard/buying',
      label: 'Buying',
      count: (
        <MyActivityCount
          which="rfps"
          initial={rfpsPosted ?? 0}
          initialActionable={buyerActionable}
          mode="with-action"
        />
      ),
    },
    {
      href: '/dashboard/bidding',
      label: 'Bidding',
      count: (
        <MyActivityCount
          which="bids"
          initial={bidsCommitted ?? 0}
          initialActionable={providerActionable}
          mode="with-action"
        />
      ),
    },
  ];

  return (
    <DashboardShell
      title="Workspace"
      titleExtra={<DashboardSyncIndicator />}
      description="Your private workspace - what you're working on, what needs your attention. Public on-chain stats live on your provider/buyer profile pages."
      tabs={tabs}
      activeHref="/dashboard"
      headerStats={
        <>
          <HeaderStat
            icon={FileTextIcon}
            label="RFPs you've posted"
            value={<MyActivityCount which="rfps" initial={rfpsPosted ?? 0} />}
            href="/dashboard/buying"
          />
          <HeaderStat
            icon={GavelIcon}
            label="Bids you've committed"
            value={<MyActivityCount which="bids" initial={bidsCommitted ?? 0} />}
            href="/dashboard/bidding"
          />
        </>
      }
      actions={
        <>
          <Link
            href="/rfps"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'h-9 gap-2 rounded-full px-4',
            )}
          >
            Browse RFPs
          </Link>
          <Link
            href="/rfps/new"
            className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-2 rounded-full px-4')}
          >
            New RFP <ArrowUpRightIcon className="size-3.5" />
          </Link>
        </>
      }
    >
      {/* Reputation snapshot - BOTH cards always render so the layout is
          balanced regardless of which roles the wallet has actually used.
          When the underlying rep account doesn't exist yet, the card shows a
          quiet zero-state telling the viewer how to populate it. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUpIcon className="size-4 text-primary" />
              Your public provider rep
            </CardTitle>
            <Link
              href={`/providers/${profileSlug}`}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              your provider profile →
            </Link>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {providerRep ? (
              <div className="grid grid-cols-3 gap-3">
                <RepMini
                  label="Wins"
                  value={String(providerRep.totalWins ?? 0)}
                  hint={`$${microUsdcToDecimal(providerRep.totalWonUsdc)} won`}
                />
                <RepMini
                  label="Completed"
                  value={String(providerRep.completedProjects ?? 0)}
                  hint={`$${microUsdcToDecimal(providerRep.totalEarnedUsdc)} earned`}
                />
                <RepMini
                  label="Late"
                  value={String(providerRep.lateMilestones ?? 0)}
                  hint="delivery deadlines missed"
                  tone={providerRep.lateMilestones > 0 ? 'warn' : 'normal'}
                />
                <RepMini
                  label="Disputed"
                  value={String(providerRep.disputedMilestones ?? 0)}
                  hint="escalations"
                  tone={providerRep.disputedMilestones > 0 ? 'warn' : 'normal'}
                />
              </div>
            ) : (
              <RepEmpty body="No provider activity yet. Win your first RFP and reputation accrues automatically — no off-chain claims, no application form." />
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Anonymous wins don't count toward this until you run <strong>Claim reputation</strong>{' '}
              from the Bidding tab on this Dashboard. Claim becomes available once the project
              completes.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUpIcon className="size-4 text-primary" />
              Your public buyer rep
            </CardTitle>
            <Link
              href={`/buyers/${profileSlug}`}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              your buyer profile →
            </Link>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {buyerRep ? (
              <div className="grid grid-cols-3 gap-3">
                <RepMini
                  label="Awarded"
                  value={String(buyerRep.totalRfps ?? 0)}
                  hint={`$${microUsdcToDecimal(buyerRep.totalLockedUsdc)} contracted`}
                />
                <RepMini
                  label="Funded"
                  value={String(buyerRep.fundedRfps ?? 0)}
                  hint="escrow locked on-chain"
                />
                <RepMini
                  label="Completed"
                  value={String(buyerRep.completedRfps ?? 0)}
                  hint={`$${microUsdcToDecimal(buyerRep.totalReleasedUsdc)} released`}
                />
                <RepMini
                  label="Cancelled"
                  value={String(buyerRep.cancelledMilestones ?? 0)}
                  hint="mid-flight cancellations"
                  tone={buyerRep.cancelledMilestones > 0 ? 'warn' : 'normal'}
                />
                <RepMini
                  label="Disputed"
                  value={String(buyerRep.disputedMilestones ?? 0)}
                  hint="escalations"
                  tone={buyerRep.disputedMilestones > 0 ? 'warn' : 'normal'}
                />
                <RepMini
                  label="Ghosted"
                  value={String(buyerRep.ghostedRfps ?? 0)}
                  hint="awarded but never funded"
                  tone={buyerRep.ghostedRfps > 0 ? 'bad' : 'normal'}
                />
              </div>
            ) : (
              <RepEmpty body="No buyer activity yet. Award your first RFP to start the on-chain track record bidders use to size you up." />
            )}
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              Anonymous RFPs don't count toward this until you run <strong>Claim reputation</strong>{' '}
              from the Buying tab on this Dashboard. Claim becomes available once the project
              completes.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* HD ephemeral wallets — sweep + top-up. Self-hides when there's
          nothing to manage; the panel handles its own loading skeleton. */}
      <EphemeralManager />
    </DashboardShell>
  );
}

function HeaderStat({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof FileTextIcon;
  label: string;
  value: React.ReactNode;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2.5 rounded-full border border-border/60 bg-card/60 py-1.5 pl-2 pr-3.5 text-sm transition-colors hover:border-primary/40 hover:bg-card"
    >
      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary">
        <Icon className="size-3.5" />
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-base font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </span>
    </Link>
  );
}

function RepEmpty({ body }: { body: string }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>;
}

function RepMini({
  label,
  value,
  hint,
  tone = 'normal',
}: { label: string; value: string; hint: string; tone?: 'normal' | 'warn' | 'bad' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-xl font-semibold tabular-nums',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </div>
  );
}
