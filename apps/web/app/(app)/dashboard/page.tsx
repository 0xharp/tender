import type { Address } from '@solana/kit';
import { ArrowUpRightIcon, FileTextIcon, GavelIcon, ScaleIcon, TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  fetchBuyerReputation,
  fetchProviderReputation,
  listBids,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
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
  const [allRfps, ownBids, buyerRep, providerRep, profileSlug] = await Promise.all([
    listRfps(),
    listBids({ providerWallet: walletAddr }),
    fetchBuyerReputation(walletAddr),
    fetchProviderReputation(walletAddr),
    // Prefer the connected wallet's .sol name in profile-link URLs so
    // hovering "your provider profile →" shows /providers/sharpre.sol
    // not /providers/CRZUd…1JYv. Falls back to pubkey if no primary set.
    preferredProfileSlug(wallet),
  ]);

  const myRfps = allRfps.filter((r) => r.data.buyer === walletAddr);
  const rfpsPosted = myRfps.length;
  const bidsCommitted = ownBids.length;
  const openRfps = allRfps.filter((r) => {
    const s = rfpStatusToString(r.data.status);
    return s === 'open' || s === 'reveal';
  }).length;

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfpsPosted ?? 0 },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCommitted ?? 0 },
  ];

  return (
    <DashboardShell
      title="Workspace"
      description="Your private workspace - what you're working on, what needs your attention. Public on-chain stats live on your provider/buyer profile pages."
      tabs={tabs}
      activeHref="/dashboard"
      actions={
        <Link
          href="/rfps/new"
          className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-2 rounded-full px-4')}
        >
          New RFP <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={FileTextIcon}
          label="RFPs you've posted"
          value={rfpsPosted ?? 0}
          href="/dashboard/buying"
        />
        <StatCard
          icon={GavelIcon}
          label="Bids you've committed"
          value={bidsCommitted ?? 0}
          href="/dashboard/bidding"
        />
        <StatCard
          icon={ScaleIcon}
          label="Open marketplace RFPs"
          value={openRfps ?? 0}
          href="/rfps"
          accent
        />
      </section>

      {/* Reputation snapshot - BOTH cards always render so the layout is
          balanced regardless of which roles the wallet has actually used.
          When the underlying rep account doesn't exist yet, the card shows a
          quiet zero-state telling the viewer how to populate it. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUpIcon className="size-4 text-primary" />
              Your provider rep
            </CardTitle>
            <Link
              href={`/providers/${profileSlug}`}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              your provider profile →
            </Link>
          </CardHeader>
          <CardContent>
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
                  label="Late · Disp."
                  value={`${providerRep.lateMilestones} · ${providerRep.disputedMilestones}`}
                  hint="lower is better"
                  warn={providerRep.lateMilestones + providerRep.disputedMilestones > 0}
                />
              </div>
            ) : (
              <RepEmpty body="No provider activity yet. Win your first RFP and reputation accrues automatically — no off-chain claims, no application form." />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TrendingUpIcon className="size-4 text-primary" />
              Your buyer rep
            </CardTitle>
            <Link
              href={`/buyers/${profileSlug}`}
              className="font-mono text-[10px] text-muted-foreground hover:text-foreground"
            >
              your buyer profile →
            </Link>
          </CardHeader>
          <CardContent>
            {buyerRep ? (
              <div className="grid grid-cols-3 gap-3">
                <RepMini
                  label="Funded"
                  value={String(buyerRep.fundedRfps ?? 0)}
                  hint={`of ${buyerRep.totalRfps} awarded`}
                />
                <RepMini
                  label="Completed"
                  value={String(buyerRep.completedRfps ?? 0)}
                  hint={`$${microUsdcToDecimal(buyerRep.totalReleasedUsdc)} released`}
                />
                <RepMini
                  label="Ghost · Canc."
                  value={`${buyerRep.ghostedRfps} · ${buyerRep.cancelledMilestones}`}
                  hint="lower is better"
                  warn={buyerRep.ghostedRfps + buyerRep.cancelledMilestones > 0}
                />
              </div>
            ) : (
              <RepEmpty body="No buyer activity yet. Award your first RFP to start the on-chain track record bidders use to size you up." />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Quick actions</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Devnet
          </span>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <QuickAction
            title="Post a new RFP"
            body="Define scope, budget range, milestones, and a reveal window."
            href="/rfps/new"
          />
          <QuickAction
            title="Browse the marketplace"
            body="See open RFPs across the platform. Sealed-bid commit lives here."
            href="/rfps"
          />
        </div>
      </section>
    </DashboardShell>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  href,
  accent,
}: {
  icon: typeof FileTextIcon;
  label: string;
  value: number;
  href: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group relative flex flex-col gap-3 overflow-hidden rounded-2xl border bg-card p-5 transition-all',
        accent
          ? 'border-primary/30 hover:border-primary/50'
          : 'border-border/60 hover:border-border',
      )}
    >
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-lg',
          accent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-mono text-3xl font-semibold tabular-nums">{value}</p>
      </div>
      <ArrowUpRightIcon className="absolute top-5 right-5 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
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
  warn,
}: { label: string; value: string; hint: string; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-xl font-semibold tabular-nums',
          warn && 'text-amber-600 dark:text-amber-400',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </div>
  );
}

function QuickAction({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1.5 rounded-xl border border-border/60 bg-background/50 p-4 transition-colors hover:border-border hover:bg-background"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {title}
        <ArrowUpRightIcon className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </Link>
  );
}
