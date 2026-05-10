'use client';

/**
 * Buying-tab grid that merges server-rendered main-wallet RFP cards
 * with HD-buyer-owned RFPs from MyActivityProvider. Server can't see
 * HD entries (chainRfp.buyer is an HD ephemeral, not the main wallet),
 * so the dashboard's "Buying" page would otherwise miss them entirely.
 *
 * For HD entries we lazy-fetch milestones for funded/inprogress states
 * (so the action label is precise — same classifier the server runs).
 * Title comes from the supabase metaByPda map.
 *
 * Renders the empty state inline when both server + HD lists are
 * empty so the page doesn't have to gate on it from the server side
 * (which can't see HD).
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { AttestRfpButton } from '@/components/profile/attest-rfp-button';
import { RfpCard, type RfpCardData } from '@/components/rfp/rfp-card';
import {
  type MyOwnedRfp,
  type TendrAccount,
  useMyActivity,
  useTendrAccount,
  useTendrSignMessage,
  useTendrSignTransactions,
} from '@/lib/wallet';

export interface BuyingGridProps {
  /** Server-rendered cards (main-wallet only). */
  serverRfps: RfpCardData[];
  /** Supabase title + scope lookup, keyed by on_chain_pda. Server has
   *  fetched ALL rfp metadata rows; we use this to populate HD entries
   *  with their real titles instead of showing "Private RFP <hash>". */
  metaByPda: Record<string, { title: string; scope_summary: string }>;
  /** Rendered when the merged list is empty (no main + no HD). */
  emptyState: ReactNode;
}

export function BuyingGrid({ serverRfps, metaByPda, emptyState }: BuyingGridProps) {
  const activity = useMyActivity();
  const account = useTendrAccount();

  // Build a quick-lookup of HD-owned RFPs that are claim-eligible
  // (completed but not yet attested via attest_buyer_history). Drives
  // the inline "Claim into public rep" CTA on the cards' action area.
  // Map keyed on PDA so the .map() below can swap it in O(1) per row.
  const claimableByPda = useMemo(() => {
    const out = new Map<string, MyOwnedRfp>();
    for (const r of activity.ownedRfps) {
      if (r.via !== 'hd') continue;
      if (r.status !== 'completed') continue;
      if (r.buyerAttested === true) continue;
      out.set(r.pda, r);
    }
    return out;
  }, [activity.ownedRfps]);

  // HD-owned RFPs come from MyActivityProvider, which has already
  // fetched the RFP + milestones during enrichment AND pre-computed
  // `nextActionLabel` / `nextActionUrgency`. We just read those —
  // no redundant in-grid fetch (which was racing the enrichment and
  // could leave a winning row showing "wait" until the local fetch
  // landed seconds after MyActivity already had the answer).
  const merged = useMemo<RfpCardData[]>(() => {
    const seen = new Set(serverRfps.map((r) => r.on_chain_pda));
    const hd = activity.ownedRfps
      .filter((r) => r.via === 'hd')
      .filter((r) => !seen.has(r.pda))
      .map<RfpCardData>((r) => {
        const meta = metaByPda[r.pda];
        return {
          on_chain_pda: r.pda,
          // Prefer the supabase-resolved title that MyActivityProvider's
          // fan-out attached directly to `r`. Fall back to the
          // server-passed `metaByPda` (covers main-wallet RFPs the
          // server already joined) and finally to the raw PDA prefix.
          title: r.title ?? meta?.title ?? `RFP ${r.pda.slice(0, 8)}…`,
          category: 'engineering',
          scope_summary: r.scopeSummary ?? meta?.scope_summary ?? '',
          bidder_visibility: r.bidderVisibility ?? 'buyer_only',
          buyer_visibility: r.buyerVisibility ?? 'private',
          bid_close_at: new Date(r.bidCloseAtMs).toISOString(),
          bid_count: r.bidCount,
          status: r.status,
          has_reserve: r.hasReserve ?? false,
          reserve_price_revealed_micro: r.reservePriceRevealed,
          actionLabel: r.nextActionLabel,
          actionUrgency: r.nextActionUrgency,
        };
      });
    return [...serverRfps, ...hd];
  }, [serverRfps, metaByPda, activity.ownedRfps]);

  // Only render the empty state once activity is settled — otherwise
  // we'd flash "no RFPs" before the cache hydration adds HD entries.
  if (merged.length === 0) {
    if (!activity.isReady) return null;
    return <>{emptyState}</>;
  }

  return (
    <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2" step={0.05} delay={0.1}>
      {merged.map((r) => {
        const claimable = claimableByPda.get(r.on_chain_pda);
        // Only render the claim slot (which calls wallet hooks) when the
        // account is non-null. Without this gate, the slot's
        // useTendrSignTransactions(account) call crashes on signout
        // because the wallet-standard hook reads `account.chains` and
        // can't handle an undefined account.
        const claimNode =
          claimable && account ? <BuyerClaimSlot rfpPda={claimable.pda} account={account} /> : null;
        return (
          <StaggerItem key={r.on_chain_pda}>
            <RfpCard
              rfp={r}
              claimNode={claimNode}
              claimPreview={
                claimable
                  ? '+1 RFP awarded · +1 funded · +1 completed (merge into your public buyer rep)'
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
 *  when the account is non-null (gate enforced at the BuyingGrid level)
 *  so the hooks never see an undefined account. Without this split, the
 *  parent BuyingGrid would have to call the hooks at top level — and
 *  the wallet-standard hooks error out when account is undefined
 *  (signout). Both `signMessage` and `signTransactions` are needed —
 *  `attest_buyer_history` requires a live binding-message signature
 *  prepended as an Ed25519SigVerify ix to prove main-wallet ownership
 *  of the RFP's buyer ephemeral. */
function BuyerClaimSlot({ rfpPda, account }: { rfpPda: string; account: TendrAccount }) {
  const signMessage = useTendrSignMessage(account);
  const signTransactions = useTendrSignTransactions(account);
  return (
    <AttestRfpButton
      rfpPda={rfpPda}
      account={account}
      signMessage={signMessage}
      signTransactions={signTransactions}
    />
  );
}
