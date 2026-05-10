'use client';

/**
 * HdProjects — surfaces HD-buyer-owned RFPs in the same urgency
 * grouping the server uses for main-wallet projects on /me/projects.
 *
 * Server-side `listProjectsForWallet` only sees main-wallet activity
 * (the on-chain `rfp.buyer` field). For HD buyers, `chainRfp.buyer`
 * is an HD ephemeral, so HD-owned RFPs never appear in the server-
 * rendered groups. This client component bridges that gap by reading
 * the merged feed from MyActivityProvider, fetching milestones per
 * RFP that needs them (funded/inprogress/disputed), and running the
 * exact same `computeNextAction` classifier the server uses for
 * main-wallet RFPs. Result: same precision — "Submitted milestone
 * 2 awaits review" / "Mark RFP expired" / "Fund the project" etc.
 *
 * Renders nothing until at least one HD-owned RFP exists. While
 * MyActivity (or the milestone fetch) is in flight, surfaces a
 * "syncing" indicator so the user understands why the section may be
 * empty momentarily.
 */
import { ArrowRightIcon, ClockIcon, LoaderCircleIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NO_ACTIVE_MILESTONE, type NextAction, computeNextAction } from '@/lib/me/next-action';
import { type MilestoneStateChain, fetchMilestones } from '@/lib/solana/chain-reads';
import { cn } from '@/lib/utils';
import { type MyOwnedRfp, useMyActivity } from '@/lib/wallet';
import type { Address } from '@solana/kit';

interface HdRow extends MyOwnedRfp {
  action: NextAction;
}

/** Status values for which the precise classifier needs milestone state.
 *  All other states classify correctly from RFP-level fields alone. */
const NEEDS_MILESTONES: ReadonlySet<string> = new Set(['funded', 'inprogress', 'disputed']);

export function HdProjects() {
  const activity = useMyActivity();
  // Per-RFP milestone snapshot, keyed by pda. Lazily populated for
  // RFPs whose status implies the classifier needs them.
  const [milestonesByPda, setMilestonesByPda] = useState<
    Record<string, (MilestoneStateChain | null)[]>
  >({});

  // Identify HD-owned RFPs that need a milestone fetch but we haven't
  // fetched yet. Re-runs cheaply when MyActivity refreshes.
  const hdRfps = useMemo(
    () => activity.ownedRfps.filter((r) => r.via === 'hd'),
    [activity.ownedRfps],
  );

  useEffect(() => {
    const needFetch = hdRfps.filter(
      (r) => NEEDS_MILESTONES.has(r.status) && !milestonesByPda[r.pda] && r.milestoneCount > 0,
    );
    if (needFetch.length === 0) return;
    let cancelled = false;
    void (async () => {
      const fetched = await Promise.all(
        needFetch.map(async (r) => {
          try {
            const ms = await fetchMilestones(r.pda as Address, r.milestoneCount);
            return { pda: r.pda, milestones: ms };
          } catch {
            return { pda: r.pda, milestones: [] as (MilestoneStateChain | null)[] };
          }
        }),
      );
      if (cancelled) return;
      setMilestonesByPda((prev) => {
        const next = { ...prev };
        for (const { pda, milestones } of fetched) next[pda] = milestones;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [hdRfps, milestonesByPda]);

  // Build classified rows. RFPs that need milestones but haven't loaded
  // yet fall back to a transient "loading" action — they'll re-render
  // with the precise label once the fetch lands.
  const rows = useMemo<HdRow[]>(() => {
    const now = Date.now();
    return hdRfps.map((r) => {
      const needsMs = NEEDS_MILESTONES.has(r.status) && r.milestoneCount > 0;
      const milestones = needsMs ? milestonesByPda[r.pda] : [];
      if (needsMs && !milestones) {
        return {
          ...r,
          action: {
            urgency: 'wait',
            label: 'Loading milestone state…',
            hint: 'Fetching the active milestone to surface the right action.',
          },
        };
      }
      const action = computeNextAction({
        role: 'buyer',
        status: r.status,
        activeMilestoneIndex: r.activeMilestoneIndex ?? NO_ACTIVE_MILESTONE,
        milestones: milestones ?? [],
        bidCloseAtMs: r.bidCloseAtMs,
        revealCloseAtMs: r.revealCloseAtMs,
        fundingDeadlineMs: r.fundingDeadlineMs ?? null,
        nowMs: now,
        bidCount: r.bidCount,
      });
      return { ...r, action };
    });
  }, [hdRfps, milestonesByPda]);

  const grouped = useMemo(() => {
    const now: HdRow[] = [];
    const wait: HdRow[] = [];
    const done: HdRow[] = [];
    for (const r of rows) {
      if (r.action.urgency === 'now') now.push(r);
      else if (r.action.urgency === 'wait' || r.action.urgency === 'soon') wait.push(r);
      else done.push(r);
    }
    return { now, wait, done };
  }, [rows]);

  // Hide entirely if there's nothing AND we're done loading.
  if (rows.length === 0 && !activity.isLoading) return null;

  return (
    <Card className="border-primary/30 bg-primary/[0.02]">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4 text-primary" />
          Your private (HD) projects
          {rows.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              ({rows.length})
            </span>
          )}
          {activity.isLoading && (
            <span
              title="Loading from your HD keychain…"
              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              <LoaderCircleIcon className="size-2.5 animate-spin" />
              syncing
            </span>
          )}
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          buyer-private
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.length === 0 ? null : (
          <>
            {grouped.now.length > 0 && (
              <Group label="Action required" tone="urgent" rows={grouped.now} />
            )}
            {grouped.wait.length > 0 && (
              <Group label="In progress" tone="wait" rows={grouped.wait} />
            )}
            {grouped.done.length > 0 && <Group label="Settled" tone="done" rows={grouped.done} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Group({
  label,
  tone,
  rows,
}: {
  label: string;
  tone: 'urgent' | 'wait' | 'done';
  rows: HdRow[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span
          className={cn(
            'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider',
            tone === 'urgent' && 'text-amber-600 dark:text-amber-400',
            tone === 'wait' && 'text-muted-foreground',
            tone === 'done' && 'text-muted-foreground',
          )}
        >
          {tone === 'wait' && <ClockIcon className="size-3" />}
          {label} · {rows.length}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
        {rows.map((r) => (
          <li key={r.pda}>
            <Link
              href={`/rfps/${r.pda}`}
              className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-card/60"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{r.action.label}</p>
                  <span
                    className="rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary"
                    title="HD-buyer ephemeral — your main wallet doesn't appear on chain for this RFP."
                  >
                    private
                  </span>
                </div>
                <p className="line-clamp-1 text-[11px] text-muted-foreground">{r.action.hint}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                  <span>
                    pda <HashLink hash={r.pda} kind="account" visibleChars={6} linkable={false} />
                  </span>
                  <span>·</span>
                  <span className="uppercase">{r.status}</span>
                </div>
              </div>
              <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
