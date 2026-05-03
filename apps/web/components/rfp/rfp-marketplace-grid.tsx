'use client';

/**
 * Sortable + filterable client view over the marketplace RFP list. Server
 * fetches the full list (chain + supabase metadata join); this component
 * handles in-browser sorting/filtering - no extra round-trip per change.
 *
 * Sort options:
 *   - Closing soon (asc by bid_close_at) - default
 *   - Recently posted (desc by bid_close_at proxy; we don't have created_at
 *     on the on-chain shape, so use bidOpenAt as proxy)
 *   - Most bids (desc by bid_count)
 *
 * Filters:
 *   - Privacy mode (any / bid content private / + identity private)
 *   - Has reserve (any / yes / no)
 */
import { useMemo, useState } from 'react';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { RfpCard, type RfpCardData } from '@/components/rfp/rfp-card';
import { cn } from '@/lib/utils';

export interface RfpMarketplaceGridProps {
  rfps: (RfpCardData & { bid_open_at?: string })[];
}

type SortKey = 'closing_soon' | 'recent' | 'most_bids';
type PrivacyFilter = 'any' | 'public' | 'buyer_only';
type ReserveFilter = 'any' | 'yes' | 'no';
// Lifecycle scopes:
//   - open:    only `status=open` AND still in the bid window (truly biddable now)
//   - active:  `open | reveal | bidsclosed` (biddable + reveal phases) - default
//   - all:     everything that has metadata, including settled (awarded /
//              funded / inprogress / completed) - useful for buyers auditing
//              their own RFPs from the same browse page.
// Reveal-lapsed RFPs are dropped server-side regardless; they have no useful
// landing experience past their reveal deadline.
type LifecycleScope = 'open' | 'active' | 'all';

export function RfpMarketplaceGrid({ rfps }: RfpMarketplaceGridProps) {
  const [sort, setSort] = useState<SortKey>('closing_soon');
  const [privacy, setPrivacy] = useState<PrivacyFilter>('any');
  const [reserve, setReserve] = useState<ReserveFilter>('any');
  const [lifecycle, setLifecycle] = useState<LifecycleScope>('active');

  const filtered = useMemo(() => {
    // PDA tiebreaker keeps the order deterministic across refreshes when two
    // RFPs tie on the primary sort key. Without it, the upstream chain query
    // returns RFPs in non-deterministic order and ties get visually shuffled.
    const byPda = (a: RfpCardData, b: RfpCardData) => a.on_chain_pda.localeCompare(b.on_chain_pda);
    const now = Date.now();

    return rfps
      .filter((r) => {
        // Lifecycle scope first - cheapest filter, drops the most candidates.
        if (lifecycle === 'open') {
          if (r.status !== 'open') return false;
          if (new Date(r.bid_close_at).getTime() <= now) return false;
        } else if (lifecycle === 'active') {
          if (r.status !== 'open' && r.status !== 'reveal' && r.status !== 'bidsclosed')
            return false;
        }
        // 'all' falls through - server already dropped reveal-lapsed dead RFPs.

        if (privacy !== 'any' && r.bidder_visibility !== privacy) return false;
        if (reserve === 'yes' && !r.has_reserve) return false;
        if (reserve === 'no' && r.has_reserve) return false;
        return true;
      })
      .slice()
      .sort((a, b) => {
        if (sort === 'most_bids') {
          const d = (b.bid_count ?? 0) - (a.bid_count ?? 0);
          return d !== 0 ? d : byPda(a, b);
        }
        if (sort === 'recent') {
          // Use bid_open_at as a recency proxy when present; fall back to bid_close_at.
          const av = new Date(a.bid_open_at ?? a.bid_close_at).getTime();
          const bv = new Date(b.bid_open_at ?? b.bid_close_at).getTime();
          const d = bv - av;
          return d !== 0 ? d : byPda(a, b);
        }
        // closing_soon: future closes ascending (soonest first), then past
        // closes descending (most-recently-closed first). Past entries used
        // to all collapse to +Infinity, which made their relative order
        // depend on the unstable upstream sort and reshuffle on refresh.
        const now = Date.now();
        const ac = new Date(a.bid_close_at).getTime();
        const bc = new Date(b.bid_close_at).getTime();
        const aFuture = ac > now;
        const bFuture = bc > now;
        if (aFuture !== bFuture) return aFuture ? -1 : 1;
        const d = aFuture ? ac - bc : bc - ac;
        return d !== 0 ? d : byPda(a, b);
      });
  }, [rfps, sort, privacy, reserve, lifecycle]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 p-2.5">
        <Group label="Show">
          <Pill active={lifecycle === 'open'} onClick={() => setLifecycle('open')}>
            Open
          </Pill>
          <Pill active={lifecycle === 'active'} onClick={() => setLifecycle('active')}>
            All active
          </Pill>
          <Pill active={lifecycle === 'all'} onClick={() => setLifecycle('all')}>
            Include settled
          </Pill>
        </Group>

        <Divider />

        <Group label="Sort">
          <Pill active={sort === 'closing_soon'} onClick={() => setSort('closing_soon')}>
            Closing soon
          </Pill>
          <Pill active={sort === 'recent'} onClick={() => setSort('recent')}>
            Recently posted
          </Pill>
          <Pill active={sort === 'most_bids'} onClick={() => setSort('most_bids')}>
            Most bids
          </Pill>
        </Group>

        <Divider />

        <Group label="Privacy">
          <Pill active={privacy === 'any'} onClick={() => setPrivacy('any')}>
            Any
          </Pill>
          <Pill active={privacy === 'public'} onClick={() => setPrivacy('public')}>
            Bid content
          </Pill>
          <Pill active={privacy === 'buyer_only'} onClick={() => setPrivacy('buyer_only')}>
            + Identity
          </Pill>
        </Group>

        <Divider />

        <Group label="Reserve">
          <Pill active={reserve === 'any'} onClick={() => setReserve('any')}>
            Any
          </Pill>
          <Pill active={reserve === 'yes'} onClick={() => setReserve('yes')}>
            Set
          </Pill>
          <Pill active={reserve === 'no'} onClick={() => setReserve('no')}>
            None
          </Pill>
        </Group>

        <span className="ml-auto text-[10px] text-muted-foreground">
          {filtered.length} of {rfps.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
          No RFPs match these filters.
        </div>
      ) : (
        <Stagger
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          step={0.05}
          delay={0.1}
        >
          {filtered.map((r) => (
            <StaggerItem key={r.on_chain_pda}>
              <RfpCard rfp={r} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="hidden h-4 w-px bg-border/60 sm:block" />;
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
