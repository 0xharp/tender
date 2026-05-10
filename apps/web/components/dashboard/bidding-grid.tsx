'use client';

/**
 * Bidding-tab grid — same RFP-card layout as the buying tab. Each
 * card represents an RFP the user has bid on (main wallet or HD).
 *
 * Architecture mirrors BuyingGrid exactly:
 *
 *   - Main-wallet bids: server-rendered. The /dashboard/bidding page
 *     fetches `listBids({ providerWallet })` + each unique RFP +
 *     milestones, computes the action label per bid (with server-side
 *     loser-gate), and passes the cards via `serverRfps`. We TRUST
 *     these — no client-side override.
 *
 *   - HD-bid entries: come from `MyActivityProvider.ownBids` filtered
 *     to `via === 'hd'`. MyActivity's enrichment fan-out has already
 *     resolved the RFP fields AND pre-computed `nextActionLabel` /
 *     `nextActionUrgency` (with the loser-gate applied), so we just
 *     read those directly. No redundant `fetchRfp` / `fetchMilestones`
 *     call from the grid — that work happened once in MyActivity.
 *
 *   - Loser-gate: applied at MyActivity-enrichment time for HD bids
 *     (label flips to "Not selected" / "You withdrew this bid" /
 *     "Bid expired" with urgency=wait). Server applies the same gate
 *     for serverRfps. Both paths converge on the same outcome by the
 *     time the card renders.
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { AttestWinButton } from '@/components/profile/attest-win-button';
import { RfpCard, type RfpCardData } from '@/components/rfp/rfp-card';
import {
  type MyOwnBid,
  type TendrAccount,
  useMyActivity,
  useTendrAccount,
  useTendrSignMessage,
  useTendrSignTransactions,
} from '@/lib/wallet';

export interface BiddingGridProps {
  /** Server-rendered RFP cards (one per main-wallet bid). Already
   *  carries `actionLabel` / `actionUrgency` with the server-side
   *  loser-gate applied — we trust these as-is. */
  serverRfps: RfpCardData[];
  /** Supabase title + scope lookup, keyed by on_chain_pda. Fallback
   *  for HD-bid RFPs whose title hasn't reached MyActivity's per-bid
   *  `rfpTitle` field yet. */
  metaByPda: Record<string, { title: string; scope_summary: string }>;
  /** Rendered when the merged list is empty (no main + no HD). */
  emptyState: ReactNode;
}

export function BiddingGrid({ serverRfps, metaByPda, emptyState }: BiddingGridProps) {
  const activity = useMyActivity();
  const account = useTendrAccount();

  // Quick-lookup of HD bids that are claim-eligible (won + RFP completed
  // + not yet attested via attest_win). Keyed on rfpPda so the .map()
  // below can swap in the AttestWinButton in O(1) per row.
  const claimableByRfpPda = useMemo(() => {
    const out = new Map<string, MyOwnBid>();
    for (const b of activity.ownBids) {
      if (b.via !== 'hd') continue;
      if (b.winnerAttested === true) continue;
      if (b.rfpStatus !== 'completed') continue;
      // For private bidder RFPs only — public bidder mode auto-credits
      // the main wallet at win time and doesn't need an attest_win step.
      if (b.rfpBidderVisibility !== 'buyer_only') continue;
      out.set(b.rfpPda, b);
    }
    return out;
  }, [activity.ownBids]);

  // HD bids the server can't see (bid.provider = ephemeral, not the
  // main wallet's listBids memcmp filter). MyActivity has already
  // attached the RFP fields + pre-computed action label/urgency onto
  // each MyOwnBid during its enrichment pass — we read directly.
  const merged = useMemo<RfpCardData[]>(() => {
    const seen = new Set(serverRfps.map((r) => r.on_chain_pda));
    const hd = activity.ownBids
      .filter((b) => b.via === 'hd')
      .filter((b) => !seen.has(b.rfpPda))
      // Skip un-enriched rows — `rfpStatus` is undefined until the
      // bid-side fan-out completes. Better to render fewer cards
      // momentarily than a row missing its status pill / banner.
      .filter((b) => b.rfpStatus !== undefined)
      .map<RfpCardData>((b) => {
        const meta = metaByPda[b.rfpPda];
        return {
          on_chain_pda: b.rfpPda,
          title: b.rfpTitle ?? meta?.title ?? `RFP ${b.rfpPda.slice(0, 8)}…`,
          category: 'engineering',
          scope_summary: b.rfpScopeSummary ?? meta?.scope_summary ?? '',
          bidder_visibility: b.rfpBidderVisibility ?? 'public',
          buyer_visibility: b.rfpBuyerVisibility ?? 'public',
          bid_close_at: new Date(b.rfpBidCloseAtMs ?? 0).toISOString(),
          bid_count: b.rfpBidCount ?? 0,
          status: b.rfpStatus,
          has_reserve: b.rfpHasReserve ?? false,
          reserve_price_revealed_micro: b.rfpReservePriceRevealed,
          actionLabel: b.nextActionLabel,
          actionUrgency: b.nextActionUrgency,
        };
      });
    return [...serverRfps, ...hd];
  }, [serverRfps, metaByPda, activity.ownBids]);

  // Only render the empty state once activity is settled — otherwise
  // we'd flash "no RFPs" before the cache hydration adds HD entries.
  if (merged.length === 0) {
    if (!activity.isReady) return null;
    return <>{emptyState}</>;
  }

  return (
    <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2" step={0.05} delay={0.1}>
      {merged.map((r) => {
        const claimable = claimableByRfpPda.get(r.on_chain_pda);
        // Per-row slot owns its wallet hooks — see ProviderClaimSlot
        // below + the analogous BuyerClaimSlot in buying-grid for the
        // signout-crash rationale.
        const claimNode =
          claimable && account ? (
            <ProviderClaimSlot
              rfpPda={claimable.rfpPda}
              bidPda={claimable.bidPda}
              account={account}
            />
          ) : null;
        return (
          <StaggerItem key={r.on_chain_pda}>
            <RfpCard
              rfp={r}
              claimNode={claimNode}
              claimPreview={
                claimable
                  ? '+1 win · +1 completed project (merge into your public provider rep)'
                  : undefined
              }
            />
          </StaggerItem>
        );
      })}
    </Stagger>
  );
}

/** Per-row claim CTA that owns its own wallet-hook calls. Rendered only
 *  when account is non-null (gate enforced at the BiddingGrid level) so
 *  the wallet-standard hooks never see undefined and crash on signout. */
function ProviderClaimSlot({
  rfpPda,
  bidPda,
  account,
}: { rfpPda: string; bidPda: string; account: TendrAccount }) {
  const signMessage = useTendrSignMessage(account);
  const signTransactions = useTendrSignTransactions(account);
  return (
    <AttestWinButton
      rfpPda={rfpPda}
      bidPda={bidPda}
      account={account}
      signMessage={signMessage}
      signTransactions={signTransactions}
    />
  );
}
