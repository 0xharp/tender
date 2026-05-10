import type { Address } from '@solana/kit';
import { TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { LeaderboardTables } from '@/components/leaderboard/leaderboard-tables';
import { SectionHeader } from '@/components/primitives/section-header';
import { resolveWalletsToSns } from '@/lib/sns/resolve';
import {
  type BuyerReputationWithAddress,
  type ProviderReputationWithAddress,
  buyerVisibilityToString,
  listBuyerReputations,
  listProviderReputations,
  listRfps,
  microUsdcToDecimal,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { snsRpc } from '@/lib/solana/client';

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
  const [buyerReps, providerReps, allRfps] = await Promise.all([
    listBuyerReputations(),
    listProviderReputations(),
    // Pulled so we can identify which BuyerReputation accounts are
    // stranded ephemeral reps (per-RFP buyer-eph keypairs that haven't
    // been merged into a main wallet via attest_buyer_history yet).
    // Those rows are filtered out of the buyer leaderboard below — they
    // have no continuity to evaluate (one-shot keypair per RFP).
    listRfps(),
  ]);

  const ZERO_PUBKEY = '11111111111111111111111111111111';

  // Set of pubkeys that are KNOWN per-RFP buyer-ephemerals: any RFP
  // whose buyer_visibility == 'private' has rfp.buyer === eph pubkey.
  // After attest_buyer_history runs, the eph rep counters get added to
  // the main wallet's rep PDA, but the eph rep PDA itself is never
  // deleted — so we filter ALWAYS, not just for unattested RFPs.
  const ephemeralBuyers = new Set<string>();
  for (const r of allRfps) {
    if (buyerVisibilityToString(r.data.buyerVisibility) === 'private') {
      ephemeralBuyers.add(String(r.data.buyer));
    }
  }

  const providerRows = providerReps
    .filter((r: ProviderReputationWithAddress) => String(r.data.provider) !== ZERO_PUBKEY)
    .map((r) => ({
      pda: String(r.address),
      wallet: String(r.data.provider),
      totalWins: r.data.totalWins,
      completedProjects: r.data.completedProjects,
      disputedMilestones: r.data.disputedMilestones,
      lateMilestones: r.data.lateMilestones,
      totalWonUsdc: microUsdcToDecimal(r.data.totalWonUsdc),
      totalEarnedUsdc: microUsdcToDecimal(r.data.totalEarnedUsdc),
      totalDisputedUsdc: microUsdcToDecimal(r.data.totalDisputedUsdc),
      lastUpdatedIso: unixSecondsToIso(r.data.lastUpdated),
    }));

  const buyerRows = buyerReps
    .filter((r: BuyerReputationWithAddress) => String(r.data.buyer) !== ZERO_PUBKEY)
    // Drop per-RFP buyer ephemerals — they're one-shot keypairs with no
    // counterparty-evaluation value. The user can claim them into their
    // main wallet's rep via attest_buyer_history, after which those
    // counters land on a different rep PDA (the main one) and that row
    // surfaces here naturally.
    .filter((r: BuyerReputationWithAddress) => !ephemeralBuyers.has(String(r.data.buyer)))
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

  // Bulk-resolve SNS for every leaderboard wallet at SSR so the first
  // paint already has `<handle>.tendr.sol` in place — no truncated→SNS
  // flash on hydration. resolveWalletsToSns dedupes and falls back to
  // null for any wallet without a tendr identity claimed.
  const allWallets = [
    ...providerRows.map((r) => r.wallet),
    ...buyerRows.map((r) => r.wallet),
  ] as Address[];
  const snsByWallet = await resolveWalletsToSns(snsRpc, allWallets);
  const snsByWalletRecord: Record<string, string | null> = {};
  for (const [w, name] of snsByWallet.entries()) snsByWalletRecord[String(w)] = name;

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
            <span className="mt-1.5 block text-[11px] leading-relaxed text-muted-foreground/85">
              Anonymous buyers + anonymous winning providers (both signed by HD-keychain ephemerals)
              don't appear here until the underlying main wallet runs{' '}
              <strong>Claim reputation</strong> from Dashboard. After claiming, their counters merge
              into the main wallet's row.
            </span>
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
        <LeaderboardTables
          providers={providerRows}
          buyers={buyerRows}
          snsByWallet={snsByWalletRecord}
        />
      )}
    </main>
  );
}
