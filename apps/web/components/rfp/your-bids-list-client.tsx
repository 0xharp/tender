'use client';

/**
 * Client-side sort/filter for the provider's bid index. Pre-loaded by the
 * server `YourBidsList` (public-mode bids signed by the main wallet) and
 * client-merged with HD-private bids from MyActivityProvider. Single
 * unified list with a per-row `private` flag — no separate cards.
 */
import { ArrowUpRightIcon, LoaderCircleIcon, LockKeyholeIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useMyActivity, useTendrAccount } from '@/lib/wallet';

export interface YourBidRow {
  bidPda: string;
  rfpPda: string;
  rfpTitle: string | null;
  submittedAtIso: string;
  /** True when the bid was signed by an HD bidder ephemeral, not the
   *  main wallet. Drives the "private" badge on the row. */
  isPrivate?: boolean;
  /** On-chain bid status. Drives the "won / not selected / withdrawn"
   *  badge so a viewer can tell at a glance which bids were actually
   *  picked by the buyer (only `selected` ones produce wins / earnings
   *  on the rep card above). */
  bidStatus?: import('@/lib/solana/chain-reads').BidStatusString;
}

export interface YourBidsListClientProps {
  rows: YourBidRow[];
  emptyTitle: string;
  emptyBody: string;
  notice?: React.ReactNode;
}

type SortKey = 'recent' | 'oldest';

export function YourBidsListClient({
  rows,
  emptyTitle,
  emptyBody,
  notice,
}: YourBidsListClientProps) {
  const [sort, setSort] = useState<SortKey>('recent');
  const [query, setQuery] = useState('');
  const account = useTendrAccount();
  const activity = useMyActivity();

  // Merge HD-private bids from the central activity feed. Server-rendered
  // public bids land first (so the list isn't empty during the activity
  // enumerate); private bids slot in by bidPda dedupe so refresh-merges
  // are idempotent.
  const mergedRows = useMemo<YourBidRow[]>(() => {
    const seen = new Set(rows.map((r) => r.bidPda));
    const hd = activity.ownBids
      .filter((b) => b.via === 'hd' && !seen.has(b.bidPda))
      .map<YourBidRow>((b) => ({
        bidPda: b.bidPda,
        rfpPda: b.rfpPda,
        rfpTitle: b.rfpTitle ?? null,
        submittedAtIso: b.submittedAtIso,
        isPrivate: true,
        bidStatus: b.bidStatus,
      }));
    return [...rows, ...hd];
  }, [rows, activity.ownBids]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mergedRows
      .filter((r) => {
        if (!q) return true;
        return (r.rfpTitle ?? '').toLowerCase().includes(q) || r.rfpPda.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => {
        const av = new Date(a.submittedAtIso).getTime();
        const bv = new Date(b.submittedAtIso).getTime();
        return sort === 'recent' ? bv - av : av - bv;
      });
  }, [mergedRows, sort, query]);

  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyholeIcon className="size-4 text-muted-foreground" />
          Your bids
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({mergedRows.length})
          </span>
          {account && activity.isLoading && (
            <span
              title="Loading your private (HD-keychain) bids…"
              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              <LoaderCircleIcon className="size-2.5 animate-spin" />
              syncing
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notice && <div className="text-xs leading-relaxed text-muted-foreground">{notice}</div>}

        {mergedRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sort
              </span>
              <Pill active={sort === 'recent'} onClick={() => setSort('recent')}>
                Most recent
              </Pill>
              <Pill active={sort === 'oldest'} onClick={() => setSort('oldest')}>
                Oldest
              </Pill>
            </div>
            <div className="ml-auto">
              <input
                type="text"
                placeholder="Filter by RFP"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-7 w-56 rounded-full border border-border bg-background px-3 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <span className="text-[10px] text-muted-foreground">
              {filtered.length} of {mergedRows.length}
            </span>
          </div>
        )}

        {mergedRows.length === 0 ? (
          <div className="flex flex-col gap-1 rounded-xl border border-dashed border-border/60 bg-card/40 p-6 text-center">
            <p className="text-sm font-medium">{emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{emptyBody}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 p-6 text-center text-xs text-muted-foreground">
            No bids match your filter.
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
            {filtered.map((r) => (
              <li key={r.bidPda} className="group">
                <Link
                  href={`/rfps/${r.rfpPda}`}
                  className={cn(
                    'flex items-center justify-between gap-4 px-4 py-3 transition-colors',
                    'hover:bg-card/60',
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {r.rfpTitle ?? (
                          <span className="text-muted-foreground">RFP {r.rfpPda.slice(0, 8)}…</span>
                        )}
                      </p>
                      {r.isPrivate && (
                        <span
                          className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"
                          title="Bid was signed by an HD-derived ephemeral wallet — your main wallet stayed off-chain during bidding."
                        >
                          private
                        </span>
                      )}
                      <BidStatusTag status={r.bidStatus} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        {/* linkable=false because the entire row is already
                            wrapped in a <Link> to the RFP - rendering this as
                            a real anchor would nest <a> inside <a> and
                            trigger a hydration error. Copy + Solscan icon
                            still work; just no row-internal navigation. */}
                        bid{' '}
                        <HashLink
                          hash={r.bidPda}
                          kind="account"
                          visibleChars={6}
                          linkable={false}
                        />
                      </span>
                      <span>·</span>
                      <span>
                        submitted <LocalTime iso={r.submittedAtIso} />
                      </span>
                    </div>
                  </div>
                  <ArrowUpRightIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Compact tag mapping the on-chain `BidCommit.status` enum to a
 *  glanceable label. `committed` (still in flight, no buyer decision yet)
 *  intentionally renders nothing — the row's "submitted" timestamp
 *  already conveys it and adding a "committed" tag everywhere is noise. */
function BidStatusTag({ status }: { status?: string }) {
  if (!status || status === 'committed' || status === 'initializing') return null;
  if (status === 'selected') {
    return (
      <span
        title="Buyer picked this bid as the winner. Wins + earnings on the rep card above include this RFP."
        className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300"
      >
        won
      </span>
    );
  }
  if (status === 'withdrawn') {
    return (
      <span
        title="You withdrew this bid before the buyer made a selection."
        className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
      >
        withdrawn
      </span>
    );
  }
  if (status === 'expired') {
    return (
      <span
        title="Reveal window closed without the buyer awarding this RFP."
        className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
      >
        expired
      </span>
    );
  }
  return null;
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-background text-muted-foreground hover:bg-card',
      )}
    >
      {children}
    </button>
  );
}
