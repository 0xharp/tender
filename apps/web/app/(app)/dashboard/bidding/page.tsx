import type { Address } from '@solana/kit';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { BiddingGrid } from '@/components/dashboard/bidding-grid';
import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { MyActivityCount } from '@/components/dashboard/my-activity-count';
import { DashboardSyncIndicator } from '@/components/dashboard/sync-indicator';
import type { RfpCardData } from '@/components/rfp/rfp-card';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { computeNextAction } from '@/lib/me/next-action';
import { listProjectsForWallet } from '@/lib/me/projects';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  bidStatusToString,
  bidderVisibilityToString,
  buyerVisibilityToString,
  fetchMilestones,
  fetchRfp,
  listBids,
  listRfps,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardBidding() {
  const wallet = (await getCurrentWallet()) as string;
  const walletAddr = wallet as Address;

  // Server-side fetches:
  //   - main-wallet bids (HD bids merge in client-side via MyActivity)
  //   - the RFPs each bid points at, in parallel (one getAccountInfo each)
  //   - all supabase metadata for title lookups
  //   - main-wallet RFPs the user owns (for the buying-tab count)
  const supabase = await serverSupabase();
  const [myRfps, ownBids, metaResult, profileSlug, projects] = await Promise.all([
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary')
      .order('created_at', { ascending: false }),
    // Resolve the connected wallet to its `<handle>.tendr.sol` for the
    // "Public profile" link — falls back to the pubkey if no claim.
    preferredProfileSlug(wallet),
    // Authoritative actionable counts per side — same source the wallet
    // pill consumes via /api/me/action-count, so the two surfaces
    // never diverge. HD additions stack on top inside MyActivityCount.
    listProjectsForWallet(walletAddr),
  ]);
  const rfpsPosted = myRfps.length;
  const bidsCommitted = ownBids.length;
  const metaByPda = new Map((metaResult.data ?? []).map((r) => [r.on_chain_pda, r]));

  // Fetch one RFP per unique rfpPda the user has bid on. Same dedupe
  // discipline as elsewhere — bids are 1:1 with RFPs (PDA derived from
  // (rfp, provider)), so the unique set IS the bid count for main mode.
  const uniqueRfpPdas = Array.from(new Set(ownBids.map((b) => String(b.data.rfp))));
  const fetched = await Promise.all(
    uniqueRfpPdas.map(async (pda) => {
      const rfp = await fetchRfp(pda as Address);
      return { pda, rfp };
    }),
  );

  // Gate the per-card provider action label on bid selection. Without
  // this, every bidder on a funded RFP — winners AND losers — inherits
  // "Start milestone N" because computeNextAction(role:'provider')
  // only inspects RFP status + milestones, not which bid actually won.
  //
  // Winner check uses `rfp.winner === bidPda` (NOT bid.status === Selected).
  // The on-chain `select_bid` writes `rfp.winner = Some(bid.key())` but
  // does NOT update bid.status because the bid is delegated to MagicBlock
  // PER and can't be mutated from base layer — so winning bids permanently
  // sit at status='committed'. Comparing against rfp.winner avoids the
  // gap entirely and works for every winning bid past + future.
  const POST_AWARD_STATUSES = new Set(['awarded', 'funded', 'inprogress', 'disputed', 'completed']);
  // bidStatus map kept around only for the withdrawn/expired cosmetic
  // label distinction — those statuses ARE written correctly on chain
  // (by withdraw_bid and by the chain expiring at reveal-close time).
  const bidStatusByRfpPda = new Map(
    ownBids.map((b) => [String(b.data.rfp), bidStatusToString(b.data.status)] as const),
  );
  // Bid PDA per RFP — for the winner check below. ownBids is filtered
  // to bid.provider === main wallet, so each entry's bid PDA is the
  // user's bid on that RFP.
  const ownBidPdaByRfpPda = new Map(
    ownBids.map((b) => [String(b.data.rfp), String(b.address)] as const),
  );

  // Per-RFP milestone fetch for funded/inprogress/disputed entries — needed
  // to surface precise provider-side action labels (e.g. "Submit milestone
  // 2" vs "Buyer reviewing milestone 2"). Skipped for other states which
  // classify from RFP fields alone.
  const milestonesByPda = new Map<string, Awaited<ReturnType<typeof fetchMilestones>>>();
  await Promise.all(
    fetched
      .filter(
        (f): f is { pda: string; rfp: NonNullable<typeof f.rfp> } =>
          f.rfp != null &&
          (() => {
            const s = rfpStatusToString(f.rfp.status);
            return (
              (s === 'funded' || s === 'inprogress' || s === 'disputed') && f.rfp.milestoneCount > 0
            );
          })(),
      )
      .map(async ({ pda, rfp }) => {
        try {
          const ms = await fetchMilestones(pda as Address, rfp.milestoneCount);
          milestonesByPda.set(pda, ms);
        } catch {
          /* best-effort */
        }
      }),
  );

  const now = Date.now();
  const serverRfps: RfpCardData[] = fetched
    .filter((f): f is { pda: string; rfp: NonNullable<typeof f.rfp> } => f.rfp != null)
    .map(({ pda, rfp }) => {
      const meta = metaByPda.get(pda);
      const status = rfpStatusToString(rfp.status);
      const action = computeNextAction({
        role: 'provider',
        status,
        activeMilestoneIndex: rfp.activeMilestoneIndex,
        milestones: milestonesByPda.get(pda) ?? [],
        bidCloseAtMs: Number(rfp.bidCloseAt) * 1000,
        revealCloseAtMs: Number(rfp.revealCloseAt) * 1000,
        fundingDeadlineMs: rfp.fundingDeadline > 0n ? Number(rfp.fundingDeadline) * 1000 : null,
        nowMs: now,
        bidCount: rfp.bidCount,
      });
      const bidStatus = bidStatusByRfpPda.get(pda);
      const ownBidPda = ownBidPdaByRfpPda.get(pda);
      // Option<Pubkey> from @solana/options needs explicit unwrap —
      // `String(option)` would return "[object Object]" and the loser
      // check below would always fire even for the actual winner.
      const winnerBidPda = rfp.winner?.__option === 'Some' ? String(rfp.winner.value) : null;
      // Winner via chain's rfp.winner, NOT bid.status (program-side gap;
      // see comment above). isLoser = winner is decided AND it's not us.
      const isLoser =
        POST_AWARD_STATUSES.has(status) && winnerBidPda != null && winnerBidPda !== ownBidPda;
      const loserLabel =
        bidStatus === 'withdrawn'
          ? 'You withdrew this bid'
          : bidStatus === 'expired'
            ? 'Bid expired'
            : 'Not selected';
      return {
        on_chain_pda: pda,
        title: meta?.title ?? `RFP ${pda.slice(0, 8)}…`,
        category: 'engineering',
        scope_summary: meta?.scope_summary ?? '',
        bid_close_at: unixSecondsToIso(rfp.bidCloseAt),
        bid_count: rfp.bidCount,
        status,
        bidder_visibility: bidderVisibilityToString(rfp.bidderVisibility),
        buyer_visibility: buyerVisibilityToString(rfp.buyerVisibility),
        has_reserve: !rfp.reservePriceCommitment.every((b: number) => b === 0),
        reserve_price_revealed_micro: rfp.reservePriceRevealed,
        actionLabel: isLoser ? loserLabel : action.label,
        actionUrgency: isLoser ? 'wait' : action.urgency,
      };
    });

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
          initial={rfpsPosted}
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
          initial={bidsCommitted}
          initialActionable={providerActionable}
          mode="with-action"
        />
      ),
    },
  ];

  return (
    <DashboardShell
      title="Bids you've committed"
      titleExtra={<DashboardSyncIndicator />}
      description="Every RFP you've bid on. Click through to manage (reveal · withdraw) on the RFP page. Reputation from anonymous wins (private bidder mode) can be claimed into your public provider rep once the project completes — look for the inline claim CTA on each completed-anonymous card."
      tabs={tabs}
      activeHref="/dashboard/bidding"
      actions={
        <Link
          href={`/providers/${profileSlug}`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-9 gap-2 rounded-full px-4',
          )}
        >
          Public Provider Profile <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      <BiddingGrid
        serverRfps={serverRfps}
        metaByPda={Object.fromEntries(
          (metaResult.data ?? []).map((m) => [
            m.on_chain_pda,
            { title: m.title, scope_summary: m.scope_summary },
          ]),
        )}
        emptyState={<EmptyBidding />}
      />
    </DashboardShell>
  );
}

function EmptyBidding() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 p-12 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        no bids yet
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        Browse the marketplace and submit a sealed bid to see it here. Both public-mode and private
        (HD-keychain) bids surface in this list.
      </p>
      <Link
        href="/rfps"
        className={cn(buttonVariants({ size: 'lg' }), 'h-11 gap-2 rounded-full px-6')}
      >
        Browse RFPs <ArrowUpRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}
