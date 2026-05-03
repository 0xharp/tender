import { TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { LeaderboardTables } from '@/components/leaderboard/leaderboard-tables';
import { SectionHeader } from '@/components/primitives/section-header';
import {
  type BuyerReputationWithAddress,
  type ProviderReputationWithAddress,
  listBuyerReputations,
  listProviderReputations,
  microUsdcToDecimal,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';

export const metadata = {
  title: 'Leaderboard - tendr.bid',
  description:
    'On-chain provider and buyer reputation rankings on the tendr.bid sealed-bid procurement marketplace.',
};

export const dynamic = 'force-dynamic';

/**
 * The leaderboard reads on-chain `BuyerReputation` + `ProviderReputation`
 * accounts in parallel and hands them to a client tab + sort component. We
 * normalize at the server boundary into plain JSON-serializable rows so the
 * client component never sees BigInt / branded-Address types.
 *
 * Skip rule: accounts whose owner is `Pubkey::default()` (uninitialized
 * placeholder from a partial init) are dropped here. This shouldn't happen in
 * practice - every code path that creates a rep account also writes the owner
 * field - but we're defensive in case of a future bug.
 */
export default async function LeaderboardPage() {
  const [buyerReps, providerReps] = await Promise.all([
    listBuyerReputations(),
    listProviderReputations(),
  ]);

  const ZERO_PUBKEY = '11111111111111111111111111111111';

  const providerRows = providerReps
    .filter((r: ProviderReputationWithAddress) => String(r.data.provider) !== ZERO_PUBKEY)
    .map((r) => ({
      pda: String(r.address),
      wallet: String(r.data.provider),
      totalWins: r.data.totalWins,
      completedProjects: r.data.completedProjects,
      disputedMilestones: r.data.disputedMilestones,
      lateMilestones: r.data.lateMilestones,
      abandonedProjects: r.data.abandonedProjects,
      totalWonUsdc: microUsdcToDecimal(r.data.totalWonUsdc),
      totalEarnedUsdc: microUsdcToDecimal(r.data.totalEarnedUsdc),
      totalDisputedUsdc: microUsdcToDecimal(r.data.totalDisputedUsdc),
      lastUpdatedIso: unixSecondsToIso(r.data.lastUpdated),
    }));

  const buyerRows = buyerReps
    .filter((r: BuyerReputationWithAddress) => String(r.data.buyer) !== ZERO_PUBKEY)
    .map((r) => ({
      pda: String(r.address),
      wallet: String(r.data.buyer),
      totalRfps: r.data.totalRfps,
      fundedRfps: r.data.fundedRfps,
      completedRfps: r.data.completedRfps,
      ghostedRfps: r.data.ghostedRfps,
      disputedMilestones: r.data.disputedMilestones,
      cancelledMilestones: r.data.cancelledMilestones,
      totalLockedUsdc: microUsdcToDecimal(r.data.totalLockedUsdc),
      totalReleasedUsdc: microUsdcToDecimal(r.data.totalReleasedUsdc),
      totalRefundedUsdc: microUsdcToDecimal(r.data.totalRefundedUsdc),
      lastUpdatedIso: unixSecondsToIso(r.data.lastUpdated),
    }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-10 sm:px-6">
      <SectionHeader
        eyebrow="Public ranking"
        title="Leaderboard"
        description={
          <>
            On-chain reputation accrues as buyers fund and providers ship. Every metric is sourced
            from the deployed Anchor program - no off-chain caches, no editorial weighting.{' '}
            <Link
              href="/docs/reputation-model"
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            >
              How reputation works →
            </Link>
          </>
        }
        size="md"
      />

      {providerRows.length === 0 && buyerRows.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-card/40 p-12 text-center backdrop-blur-md">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <TrendingUpIcon className="size-5" />
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-display text-xl font-semibold tracking-tight">
              No reputation data yet
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              The first award + first milestone settlement will populate this page. Until then, the
              registry is empty by design.
            </p>
          </div>
        </div>
      ) : (
        <LeaderboardTables providers={providerRows} buyers={buyerRows} />
      )}
    </main>
  );
}
