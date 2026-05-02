'use client';

/**
 * Client-side sort/filter for the provider's bid index. Pre-loaded by the
 * server `YourBidsList`. Default sort: most recent first.
 */
import { ArrowUpRightIcon, LockKeyholeIcon } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface YourBidRow {
  bidPda: string;
  rfpPda: string;
  rfpTitle: string | null;
  submittedAtIso: string;
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => {
        if (!q) return true;
        return (
          (r.rfpTitle ?? '').toLowerCase().includes(q) ||
          r.rfpPda.toLowerCase().includes(q)
        );
      })
      .slice()
      .sort((a, b) => {
        const av = new Date(a.submittedAtIso).getTime();
        const bv = new Date(b.submittedAtIso).getTime();
        return sort === 'recent' ? bv - av : av - bv;
      });
  }, [rows, sort, query]);

  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyholeIcon className="size-4 text-muted-foreground" />
          Public-mode bids
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({rows.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notice && <div className="text-xs leading-relaxed text-muted-foreground">{notice}</div>}

        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card/40 p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Sort</span>
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
              {filtered.length} of {rows.length}
            </span>
          </div>
        )}

        {rows.length === 0 ? (
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
                    <p className="truncate text-sm font-medium">
                      {r.rfpTitle ?? (
                        <span className="text-muted-foreground">RFP {r.rfpPda.slice(0, 8)}…</span>
                      )}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span>
                        bid <HashLink hash={r.bidPda} kind="account" visibleChars={6} />
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
