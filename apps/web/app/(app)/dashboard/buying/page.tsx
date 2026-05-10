import type { Address } from '@solana/kit';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { BuyingGrid } from '@/components/dashboard/buying-grid';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MyActivityCount } from '@/components/dashboard/my-activity-count';
import { DashboardSyncIndicator } from '@/components/dashboard/sync-indicator';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { computeNextAction } from '@/lib/me/next-action';
import { listProjectsForWallet } from '@/lib/me/projects';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  bidderVisibilityToString,
  buyerVisibilityToString,
  fetchMilestones,
  listBids,
  listRfps,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardBuying() {
  const wallet = (await getCurrentWallet()) as string;
  const walletAddr = wallet as Address;

  // On-chain reads + supabase metadata join. The bid count is public-mode only;
  // private bids are intentionally not enumerable from the main wallet.
  // `listProjectsForWallet` powers the authoritative actionable counts
  // for both tabs (matches the wallet-pill formula exactly so the two
  // surfaces never diverge).
  const supabase = await serverSupabase();
  const [chainRfps, ownBids, metaResult, profileSlug, projects] = await Promise.all([
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary, created_at')
      .order('created_at', { ascending: false }),
    // For the "Buyer profile" link in the page actions — resolves the
    // wallet's `<handle>.tendr.sol` slug or falls back to the pubkey.
    preferredProfileSlug(wallet),
    listProjectsForWallet(walletAddr),
  ]);

  const error = metaResult.error;
  const metaByPda = new Map((metaResult.data ?? []).map((r) => [r.on_chain_pda, r]));
  const bidsCount = ownBids.length;

  // Per-RFP milestone fetch for funded/inprogress/disputed entries — needed
  // by computeNextAction to surface precise action labels (e.g. "Review
  // milestone 2" vs "Provider working on milestone 2"). Other states classify
  // from RFP fields alone, so we skip the fetch for them.
  const milestonesByPda = new Map<string, Awaited<ReturnType<typeof fetchMilestones>>>();
  await Promise.all(
    chainRfps
      .filter(({ data }) => {
        const s = rfpStatusToString(data.status);
        return (
          (s === 'funded' || s === 'inprogress' || s === 'disputed') && data.milestoneCount > 0
        );
      })
      .map(async ({ address, data }) => {
        try {
          const ms = await fetchMilestones(address as Address, data.milestoneCount);
          milestonesByPda.set(address, ms);
        } catch {
          /* best-effort — falls back to status-only classification */
        }
      }),
  );

  const now = Date.now();
  const rfps = chainRfps
    .map(({ address, data }) => {
      const meta = metaByPda.get(address);
      if (!meta) return null;
      const status = rfpStatusToString(data.status);
      const action = computeNextAction({
        role: 'buyer',
        status,
        activeMilestoneIndex: data.activeMilestoneIndex,
        milestones: milestonesByPda.get(address) ?? [],
        bidCloseAtMs: Number(data.bidCloseAt) * 1000,
        revealCloseAtMs: Number(data.revealCloseAt) * 1000,
        fundingDeadlineMs: data.fundingDeadline > 0n ? Number(data.fundingDeadline) * 1000 : null,
        nowMs: now,
        bidCount: data.bidCount,
      });
      return {
        on_chain_pda: address,
        title: meta.title,
        category: 'engineering',
        scope_summary: meta.scope_summary,
        bid_close_at: unixSecondsToIso(data.bidCloseAt),
        bid_count: data.bidCount,
        status,
        bidder_visibility: bidderVisibilityToString(data.bidderVisibility),
        buyer_visibility: buyerVisibilityToString(data.buyerVisibility),
        has_reserve: !data.reservePriceCommitment.every((b: number) => b === 0),
        reserve_price_revealed_micro: data.reservePriceRevealed,
        actionLabel: action.label,
        actionUrgency: action.urgency,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  // Server-authoritative actionable counts per side — same source the
  // wallet pill consumes via /api/me/action-count. HD additions stack
  // on top inside MyActivityCount.
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
          initial={rfps.length}
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
          initial={bidsCount}
          initialActionable={providerActionable}
          mode="with-action"
        />
      ),
    },
  ];

  return (
    <DashboardShell
      title="RFPs you've posted"
      titleExtra={<DashboardSyncIndicator />}
      description="Every RFP you've created, in any state. Open, in reveal, awarded, or closed. Reputation from anonymous RFPs can be claimed into your public buyer rep once the project completes — look for the inline claim CTA on each completed-anonymous card."
      tabs={tabs}
      activeHref="/dashboard/buying"
      actions={
        <Link
          href={`/buyers/${profileSlug}`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-9 gap-2 rounded-full px-4',
          )}
        >
          Public Buyer Profile <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      {error && (
        <div className="rounded-xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load metadata: {error.message}
        </div>
      )}

      {!error && (
        <BuyingGrid
          serverRfps={rfps}
          metaByPda={Object.fromEntries(
            (metaResult.data ?? []).map((m) => [
              m.on_chain_pda,
              { title: m.title, scope_summary: m.scope_summary },
            ]),
          )}
          emptyState={<EmptyBuying />}
        />
      )}
    </DashboardShell>
  );
}

function EmptyBuying() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 p-12 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        no RFPs yet
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        Posting an RFP derives an RFP-specific X25519 keypair from your wallet signature, mints the
        on-chain account, and opens it for sealed bids.
      </p>
      <Link
        href="/rfps/new"
        className={cn(buttonVariants({ size: 'lg' }), 'h-11 gap-2 rounded-full px-6')}
      >
        Post your first RFP <ArrowUpRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}
