/**
 * Buyer-profile "RFPs by status" card. Pure-public surface — server
 * passes the public-mode entries (memcmp on `rfp.buyer == wallet`)
 * grouped by status, and we render them.
 *
 * v2 — owner-only HD merge removed. Anonymous activity is now managed
 * from /dashboard/buying via the per-card claim CTA; profile pages
 * stay purely public so own-profile == visitor view. Component is now
 * a server component — no client-side state, no MyActivity dep.
 */
import { ScrollTextIcon } from 'lucide-react';
import Link from 'next/link';

import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface BuyerRfpEntry {
  pda: string;
  title: string;
}

export interface BuyerRfpsByStatusProps {
  walletAddress: string;
  /** Server-fetched entries grouped by status (public-mode only —
   *  including any anon RFPs the buyer has claimed via attest). */
  serverEntriesByStatus: Record<string, BuyerRfpEntry[]>;
  /** Stable status display order. */
  statusOrder: string[];
}

export function BuyerRfpsByStatus({
  walletAddress: _walletAddress,
  serverEntriesByStatus,
  statusOrder,
}: BuyerRfpsByStatusProps) {
  const orderedStatuses = statusOrder.filter((s) => (serverEntriesByStatus[s]?.length ?? 0) > 0);
  const totalCount = Object.values(serverEntriesByStatus).reduce((acc, e) => acc + e.length, 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollTextIcon className="size-4 text-muted-foreground" />
          Public RFPs by status
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {totalCount} total
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Scope clarification — addresses the "I claimed reputation for
            my anonymous RFP, why doesn't it appear here?" question. The
            attest_buyer_history flow only merges reputation COUNTERS;
            the underlying RFP account stays in private-buyer mode and
            never gets a public buyer→rfp link displayed in any UI. */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Lists only RFPs created in public buyer mode. Anonymous RFPs claimed via{' '}
          <strong>Claim reputation</strong> add their counters to the Reputation card above but stay
          off this list — the RFPs themselves remain anonymous on chain.
        </p>
        {orderedStatuses.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
            This buyer hasn’t created any RFPs yet.
          </p>
        ) : (
          orderedStatuses.map((status) => {
            const entries = serverEntriesByStatus[status] ?? [];
            return (
              <div key={status} className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {status} · {entries.length}
                  </span>
                </div>
                <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
                  {entries.map((e) => (
                    <li key={e.pda}>
                      <Link
                        href={`/rfps/${e.pda}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-card/60"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="truncate font-medium">{e.title}</span>
                        </span>
                        <HashLink hash={e.pda} kind="account" visibleChars={6} linkable={false} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
