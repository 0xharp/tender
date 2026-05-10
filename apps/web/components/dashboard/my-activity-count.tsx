'use client';

/**
 * Live count from MyActivityProvider — used in dashboard tab badges
 * and overview StatCards so the "RFPs you've posted" / "Bids you've
 * committed" numbers reflect main + HD entries (not just main wallet
 * via the server-side enumerate).
 *
 * When `mode === 'with-action'` the badge reads "{total} · {N action}"
 * with the action count surfaced in amber so the user can spot at a
 * glance how many items are blocking them.
 *
 * Action-count source-of-truth: matches the wallet pill formula
 * (server-side count for main-wallet activity + client-side HD count
 * from MyActivity). The server's count is authoritative for main-
 * wallet rows because it always has fresh milestone data; relying
 * solely on MyActivity's client-side enrichment caused under-counting
 * when an RFP fetch silently failed mid-enumerate. Client adds HD
 * rows on top — the server can't see HD-buyer RFPs (rfp.buyer is the
 * eph) or HD-bidder bids (bid.provider is the eph), so those have to
 * come from the client-side keychain enumerate.
 *
 * Falls back to `initialTotal` while activity is still loading (or
 * before cache hydration), so SSR + first paint never shows 0.
 */
import { type MyOwnBid, type MyOwnedRfp, useMyActivity } from '@/lib/wallet';

export interface MyActivityCountProps {
  which: 'rfps' | 'bids';
  /** Server-rendered TOTAL count for the SSR / no-JS fallback. */
  initial: number;
  /** Server-rendered ACTIONABLE count (main-wallet rows whose
   *  computeNextAction urgency === 'now'). When set, this seeds the
   *  authoritative main-wallet-side count; HD additions stack on top
   *  from the client-side MyActivity enumerate. Required for
   *  `with-action` mode to be accurate. */
  initialActionable?: number;
  /** When set, also surfaces an "(N action)" segment alongside the
   *  total. Defaults to `total-only` for backward compat. */
  mode?: 'total-only' | 'with-action';
}

export function MyActivityCount({
  which,
  initial,
  initialActionable,
  mode = 'total-only',
}: MyActivityCountProps) {
  const activity = useMyActivity();
  if (!activity.isReady) {
    if (mode !== 'with-action') return <>{initial}</>;
    if (!initialActionable) return <>{initial}</>;
    return (
      <>
        {initial}
        <span className="ml-1 rounded-full bg-amber-500/20 px-1 text-[9px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
          {initialActionable}
        </span>
      </>
    );
  }
  const items = which === 'rfps' ? activity.ownedRfps : activity.ownBids;
  const total = items.length;
  if (mode !== 'with-action') return <>{total}</>;

  // Server count (main-wallet) + HD additions (from MyActivity).
  // Identical formula to the wallet pill so the two surfaces never
  // diverge. We can't double-count by adding HD rows on top of
  // server: server-side `listProjectsForWallet` filters by
  // `buyer == mainWallet` / `winnerProvider == mainWallet`, neither
  // of which match an HD ephemeral, so HD rows are guaranteed to
  // be disjoint from what the server counted.
  const serverActionable = initialActionable ?? 0;
  const hdActionable = items.filter((item) => {
    const row = item as MyOwnedRfp | MyOwnBid;
    return row.via === 'hd' && row.nextActionUrgency === 'now';
  }).length;
  const actionable = serverActionable + hdActionable;

  if (actionable === 0) return <>{total}</>;
  return (
    <>
      {total}
      <span className="ml-1 rounded-full bg-amber-500/20 px-1 text-[9px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
        {actionable}
      </span>
    </>
  );
}
