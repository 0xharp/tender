'use client';

/**
 * Sortable two-tab leaderboard ("Top providers" + "Top buyers").
 *
 * Server hands us pre-decoded, pre-formatted JSON-safe rows so this component
 * only owns sort state + render. PDA tiebreaker on every column makes the
 * order stable across refreshes (otherwise the upstream `getProgramAccounts`
 * order leaks through ties and the table reshuffles per page-load).
 *
 * Edge cases covered:
 *   - empty list per tab -> friendly empty state, not a blank table
 *   - rows with `completed_projects = 0` AND `total_won > 0` (won but not yet
 *     shipped) render normally; sort by completed pushes them to the bottom
 *   - all-zero stats (rep account exists but no activity) render with em-dash
 *     placeholders for ratios so we don't divide by zero
 */
import type { Address } from '@solana/kit';
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent } from '@/components/ui/card';
import { primeSnsCache } from '@/lib/sns/cache';
import { useSnsName } from '@/lib/sns/hooks';
import { resolveWalletsToSns } from '@/lib/sns/resolve';
import { snsRpc } from '@/lib/solana/client';
import { cn } from '@/lib/utils';

export interface ProviderRow {
  pda: string;
  wallet: string;
  totalWins: number;
  completedProjects: number;
  disputedMilestones: number;
  lateMilestones: number;
  abandonedProjects: number;
  totalWonUsdc: string;
  totalEarnedUsdc: string;
  totalDisputedUsdc: string;
  lastUpdatedIso: string;
}

export interface BuyerRow {
  pda: string;
  wallet: string;
  totalRfps: number;
  fundedRfps: number;
  completedRfps: number;
  ghostedRfps: number;
  disputedMilestones: number;
  cancelledMilestones: number;
  totalLockedUsdc: string;
  totalReleasedUsdc: string;
  totalRefundedUsdc: string;
  lastUpdatedIso: string;
}

type Tab = 'providers' | 'buyers';

type ProviderSort = 'wins' | 'completed' | 'earned' | 'won' | 'disputed' | 'late' | 'recent';

type BuyerSort = 'rfps' | 'funded' | 'completed' | 'released' | 'locked' | 'ghosted' | 'recent';

export function LeaderboardTables({
  providers,
  buyers,
}: {
  providers: ProviderRow[];
  buyers: BuyerRow[];
}) {
  const [tab, setTab] = useState<Tab>('providers');

  // Bulk-prime the SNS cache with one batched RPC call covering every wallet
  // on both tabs. Without this, each row's HashLink (with withSns) would fire
  // its own resolveWalletToSns - 20+ round-trips per leaderboard render.
  // After the prime, individual hooks hit the in-memory cache instantly.
  useEffect(() => {
    const wallets = [
      ...providers.map((r) => r.wallet),
      ...buyers.map((r) => r.wallet),
    ] as Address[];
    if (wallets.length === 0) return;
    void resolveWalletsToSns(snsRpc, wallets).then(primeSnsCache);
  }, [providers, buyers]);

  return (
    <div className="flex flex-col gap-4">
      <div className="inline-flex w-fit items-center gap-1 rounded-full border border-border/60 bg-card/40 p-1 backdrop-blur-md">
        <TabButton active={tab === 'providers'} onClick={() => setTab('providers')}>
          Top providers
          <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
            {providers.length}
          </span>
        </TabButton>
        <TabButton active={tab === 'buyers'} onClick={() => setTab('buyers')}>
          Top buyers
          <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
            {buyers.length}
          </span>
        </TabButton>
      </div>

      {tab === 'providers' ? <ProvidersTable rows={providers} /> : <BuyersTable rows={buyers} />}
    </div>
  );
}

function ProvidersTable({ rows }: { rows: ProviderRow[] }) {
  const [sort, setSort] = useState<ProviderSort>('completed');
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    // PDA tiebreaker keeps row order deterministic across refreshes when two
    // accounts tie on the primary key. localeCompare on PDA is stable.
    const byPda = (a: ProviderRow, b: ProviderRow) => a.pda.localeCompare(b.pda);
    const cmp = (a: ProviderRow, b: ProviderRow) => {
      let d = 0;
      switch (sort) {
        case 'wins':
          d = a.totalWins - b.totalWins;
          break;
        case 'completed':
          d = a.completedProjects - b.completedProjects;
          break;
        case 'earned':
          d = Number(a.totalEarnedUsdc) - Number(b.totalEarnedUsdc);
          break;
        case 'won':
          d = Number(a.totalWonUsdc) - Number(b.totalWonUsdc);
          break;
        case 'disputed':
          d = a.disputedMilestones - b.disputedMilestones;
          break;
        case 'late':
          d = a.lateMilestones - b.lateMilestones;
          break;
        case 'recent':
          d = new Date(a.lastUpdatedIso).getTime() - new Date(b.lastUpdatedIso).getTime();
          break;
      }
      if (d !== 0) return asc ? d : -d;
      return byPda(a, b);
    };
    return [...rows].sort(cmp);
  }, [rows, sort, asc]);

  if (rows.length === 0) {
    return <EmptyTab message="No providers have won an RFP yet." />;
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Rank</th>
                <th className="px-4 py-3 text-left">Provider</th>
                <SortHeader
                  active={sort === 'completed'}
                  asc={asc}
                  onClick={() => toggleSort('completed', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Completed
                </SortHeader>
                <SortHeader
                  active={sort === 'wins'}
                  asc={asc}
                  onClick={() => toggleSort('wins', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Wins
                </SortHeader>
                <SortHeader
                  active={sort === 'earned'}
                  asc={asc}
                  onClick={() => toggleSort('earned', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Earned (USDC)
                </SortHeader>
                <SortHeader
                  active={sort === 'won'}
                  asc={asc}
                  onClick={() => toggleSort('won', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Won (USDC)
                </SortHeader>
                <SortHeader
                  active={sort === 'disputed'}
                  asc={asc}
                  onClick={() => toggleSort('disputed', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Disputed
                </SortHeader>
                <SortHeader
                  active={sort === 'late'}
                  asc={asc}
                  onClick={() => toggleSort('late', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Late
                </SortHeader>
                <SortHeader
                  active={sort === 'recent'}
                  asc={asc}
                  onClick={() => toggleSort('recent', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Last activity
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr
                  key={row.pda}
                  className="border-b border-border/30 text-sm transition-colors last:border-0 hover:bg-card/60"
                >
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground tabular-nums">
                    #{i + 1}
                  </td>
                  <td className="px-4 py-3">
                    <ProfileLink kind="providers" wallet={row.wallet}>
                      <HashLink
                        hash={row.wallet}
                        kind="account"
                        visibleChars={6}
                        linkable={false}
                        withSns
                      />
                    </ProfileLink>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {row.completedProjects}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{row.totalWins}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    ${formatUsdc(row.totalEarnedUsdc)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                    ${formatUsdc(row.totalWonUsdc)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-mono tabular-nums',
                      row.disputedMilestones > 0 && 'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {row.disputedMilestones}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-mono tabular-nums',
                      row.lateMilestones > 0 && 'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {row.lateMilestones}
                  </td>
                  <td className="px-4 py-3 text-right text-[11px] text-muted-foreground">
                    <LocalTime iso={row.lastUpdatedIso} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function BuyersTable({ rows }: { rows: BuyerRow[] }) {
  const [sort, setSort] = useState<BuyerSort>('completed');
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const byPda = (a: BuyerRow, b: BuyerRow) => a.pda.localeCompare(b.pda);
    const cmp = (a: BuyerRow, b: BuyerRow) => {
      let d = 0;
      switch (sort) {
        case 'rfps':
          d = a.totalRfps - b.totalRfps;
          break;
        case 'funded':
          d = a.fundedRfps - b.fundedRfps;
          break;
        case 'completed':
          d = a.completedRfps - b.completedRfps;
          break;
        case 'released':
          d = Number(a.totalReleasedUsdc) - Number(b.totalReleasedUsdc);
          break;
        case 'locked':
          d = Number(a.totalLockedUsdc) - Number(b.totalLockedUsdc);
          break;
        case 'ghosted':
          d = a.ghostedRfps - b.ghostedRfps;
          break;
        case 'recent':
          d = new Date(a.lastUpdatedIso).getTime() - new Date(b.lastUpdatedIso).getTime();
          break;
      }
      if (d !== 0) return asc ? d : -d;
      return byPda(a, b);
    };
    return [...rows].sort(cmp);
  }, [rows, sort, asc]);

  if (rows.length === 0) {
    return <EmptyTab message="No buyers have awarded an RFP yet." />;
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 text-left">Rank</th>
                <th className="px-4 py-3 text-left">Buyer</th>
                <SortHeader
                  active={sort === 'completed'}
                  asc={asc}
                  onClick={() => toggleSort('completed', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Completed
                </SortHeader>
                <SortHeader
                  active={sort === 'funded'}
                  asc={asc}
                  onClick={() => toggleSort('funded', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Funded
                </SortHeader>
                <SortHeader
                  active={sort === 'rfps'}
                  asc={asc}
                  onClick={() => toggleSort('rfps', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Awarded
                </SortHeader>
                <SortHeader
                  active={sort === 'released'}
                  asc={asc}
                  onClick={() => toggleSort('released', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Released (USDC)
                </SortHeader>
                <SortHeader
                  active={sort === 'locked'}
                  asc={asc}
                  onClick={() => toggleSort('locked', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Locked (USDC)
                </SortHeader>
                <SortHeader
                  active={sort === 'ghosted'}
                  asc={asc}
                  onClick={() => toggleSort('ghosted', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Ghosted
                </SortHeader>
                <SortHeader
                  active={sort === 'recent'}
                  asc={asc}
                  onClick={() => toggleSort('recent', sort, setSort, asc, setAsc)}
                  align="right"
                >
                  Last activity
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => (
                <tr
                  key={row.pda}
                  className="border-b border-border/30 text-sm transition-colors last:border-0 hover:bg-card/60"
                >
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground tabular-nums">
                    #{i + 1}
                  </td>
                  <td className="px-4 py-3">
                    <ProfileLink kind="buyers" wallet={row.wallet}>
                      <HashLink
                        hash={row.wallet}
                        kind="account"
                        visibleChars={6}
                        linkable={false}
                        withSns
                      />
                    </ProfileLink>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    {row.completedRfps}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{row.fundedRfps}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                    {row.totalRfps}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">
                    ${formatUsdc(row.totalReleasedUsdc)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                    ${formatUsdc(row.totalLockedUsdc)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-mono tabular-nums',
                      row.ghostedRfps > 0 && 'text-destructive',
                    )}
                  >
                    {row.ghostedRfps}
                  </td>
                  <td className="px-4 py-3 text-right text-[11px] text-muted-foreground">
                    <LocalTime iso={row.lastUpdatedIso} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function TabButton({
  active,
  onClick,
  children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center rounded-full px-3 py-1 text-xs transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-card hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function SortHeader({
  children,
  active,
  asc,
  onClick,
  align = 'left',
}: {
  children: React.ReactNode;
  active: boolean;
  asc: boolean;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={cn('px-4 py-3', align === 'right' ? 'text-right' : 'text-left')}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider transition-colors',
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {children}
        {active &&
          (asc ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
      </button>
    </th>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-8 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

/**
 * Per-row link wrapper that builds the profile URL using `.sol` slug when
 * the wallet has a primary domain, falling back to the pubkey otherwise.
 *
 * Hook is fine inside this component since it's rendered per-row inside
 * `.map()` — each row gets its own hook instance. The bulk-prime in the
 * parent already populated the cache, so reads here are synchronous from
 * the in-memory layer once mounted.
 *
 * Initial render uses the pubkey URL (the hook returns undefined on the
 * first frame to stay hydration-safe). After mount + cache hit, the href
 * swaps to the .sol form. Attribute updates don't trigger hydration
 * mismatches; only DOM-text or initial-attribute mismatches do.
 */
function ProfileLink({
  kind,
  wallet,
  children,
}: {
  kind: 'providers' | 'buyers';
  wallet: string;
  children: React.ReactNode;
}) {
  const snsName = useSnsName(wallet as Address);
  const slug = snsName ?? wallet;
  return (
    <Link
      href={`/${kind}/${slug}`}
      className="font-mono text-xs text-foreground hover:text-primary"
    >
      {children}
    </Link>
  );
}

function toggleSort<S>(
  next: S,
  current: S,
  setCurrent: (s: S) => void,
  asc: boolean,
  setAsc: (a: boolean) => void,
) {
  if (current === next) {
    setAsc(!asc);
  } else {
    setCurrent(next);
    setAsc(false); // Default to descending - "best at top" intuition for most metrics.
  }
}

/** Format a decimal-string USDC value with thousands separators + 2 decimal cap. */
function formatUsdc(decimal: string): string {
  const n = Number(decimal);
  if (!Number.isFinite(n) || n === 0) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}
