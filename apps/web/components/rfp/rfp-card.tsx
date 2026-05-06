import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { type PrivacyMode, PrivacyTag } from '@/components/primitives/privacy-tag';
import { ReserveTag } from '@/components/primitives/reserve-tag';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { stripMarkdown } from '@/lib/markdown/strip';
import { cn } from '@/lib/utils';

export interface RfpCardData {
  on_chain_pda: string;
  title: string;
  category: string;
  scope_summary: string;
  /** Bidder visibility - "public" or "buyer_only". */
  bidder_visibility: string;
  bid_close_at: string;
  /** Reveal-window deadline. When in `reveal` past this, the RFP is lapsed
   *  (no award possible). Optional for backwards compat. */
  reveal_close_at?: string;
  bid_count: number;
  status?: string;
  /** Whether a reserve commitment exists on chain. */
  has_reserve?: boolean;
  /** Post-award only - revealed reserve value in USDC base units. */
  reserve_price_revealed_micro?: bigint;
  /** True when the signed-in viewer is the buyer for this RFP. Drives a
   *  visual highlight (primary ring + "YOURS" badge) so the buyer can
   *  spot their own RFPs while browsing the marketplace. */
  mine?: boolean;
}

function timeLeft(iso: string): { label: string; tone: 'normal' | 'urgent' | 'closed' } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { label: 'closed', tone: 'closed' };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { label: `${hours}h left`, tone: 'urgent' };
  return { label: `${Math.floor(hours / 24)}d left`, tone: 'normal' };
}

function statusTone(status?: string): StatusTone {
  if (status === 'open') return 'open';
  if (status === 'reveal') return 'reveal';
  if (status === 'awarded') return 'awarded';
  if (status === 'bidsclosed' || status === 'bid window closed') return 'sealed';
  // Terminal / dead states - render muted so they don't compete visually
  // with active RFPs in the marketplace grid.
  if (
    status === 'closed' ||
    status === 'reveal window lapsed' ||
    status === 'expired' ||
    status === 'cancelled' ||
    status === 'completed' ||
    status === 'ghostedbybuyer'
  ) {
    return 'closed';
  }
  return 'open';
}

/** Display status:
 *  - on-chain `open` past `bid_close_at` → "bid window closed" (waiting for the
 *    buyer or anyone to call `rfp_close_bidding`).
 *  - on-chain `reveal`/`bidsclosed` past `reveal_close_at` → "reveal window
 *    lapsed" (RFP is dead - no award possible). */
function displayStatus(
  status: string | undefined,
  bidCloseAtIso: string,
  revealCloseAtIso: string | undefined,
): string {
  const now = Date.now();
  const bidClosed = new Date(bidCloseAtIso).getTime() <= now;
  const revealClosed = revealCloseAtIso ? new Date(revealCloseAtIso).getTime() <= now : false;
  if ((status === 'reveal' || status === 'bidsclosed') && revealClosed) {
    return 'reveal window lapsed';
  }
  if (status === 'open' && bidClosed) return 'bid window closed';
  return status ?? 'open';
}

export function RfpCard({ rfp }: { rfp: RfpCardData }) {
  const time = timeLeft(rfp.bid_close_at);
  const status = displayStatus(rfp.status, rfp.bid_close_at, rfp.reveal_close_at);
  // Hide the top-right time chip when bidding is over (the StatusPill +
  // bottom-row "Bidding closes" already convey it) OR when the "Mine"
  // corner ribbon is on (the ribbon occupies the same top-right corner
  // and the bottom-row date is enough).
  const showTimeChip = time.tone !== 'closed' && !rfp.mine;

  return (
    <Link
      href={`/rfps/${rfp.on_chain_pda}`}
      className={cn(
        'group relative flex h-full flex-col gap-4 overflow-hidden rounded-2xl border bg-card p-5 transition-all',
        'hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5',
        // "Your RFP" treatment: a stronger primary-tinted border + subtle
        // background tint, so the buyer can scan the grid and spot their
        // own RFPs at a glance. Falls back to the neutral border + hover
        // accent for everyone else's RFPs.
        rfp.mine
          ? 'border-primary/50 bg-primary/[0.04] hover:border-primary/70'
          : 'border-border/60 hover:border-primary/30',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
      />

      {/* "Mine" corner ribbon — cheque-stamp style, sits diagonally across
          the top-right corner. Clipped by the card's overflow-hidden so
          it reads as a banner rather than an overflowing div. Kept inside
          the Link so the whole card (including the ribbon area) is
          clickable, and aria-hidden because the visual cue is supplemental
          to the border-tint distinction; screen readers don't need it
          announced separately from "Your RFP" semantics elsewhere. */}
      {rfp.mine && (
        <div
          aria-hidden
          className="pointer-events-none absolute -right-14 top-5 z-10 rotate-45 bg-primary px-16 py-1 text-center font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-primary-foreground shadow-md shadow-primary/30 ring-1 ring-primary-foreground/10"
        >
          Mine
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone={statusTone(status)}>{status}</StatusPill>
          <PrivacyTag mode={(rfp.bidder_visibility as PrivacyMode) ?? 'public'} />
          <ReserveTag
            hasReserve={!!rfp.has_reserve}
            revealedMicroUsdc={rfp.reserve_price_revealed_micro}
          />
        </div>
        {showTimeChip && (
          <span
            className={cn(
              'font-mono text-[10px] tabular-nums uppercase tracking-wider',
              time.tone === 'urgent' && 'text-amber-600 dark:text-amber-400',
              time.tone === 'normal' && 'text-muted-foreground',
            )}
          >
            {time.label}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {rfp.category.replace(/_/g, ' ')}
        </span>
        <h3 className="font-display text-lg font-semibold leading-tight tracking-tight text-foreground transition-colors group-hover:text-primary">
          {rfp.title}
        </h3>
        {/* Strip markdown source for the snippet — `**bold**` literals
            look ugly in line-clamp-2. Full markdown render lives on the
            RFP detail page (one click away via the wrapping <Link>). */}
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {stripMarkdown(rfp.scope_summary)}
        </p>
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-border/60 pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {time.tone === 'closed' ? 'Bidding closed' : 'Bidding closes'}
          </span>
          <span className="font-mono text-xs text-foreground/80">
            {time.tone === 'closed'
              ? // Pin to UTC so server (UTC by default) and client (local TZ)
                // both render the same calendar day. Without timeZone:'UTC'
                // a bid_close_at near midnight UTC formats as e.g. "May 5"
                // on the server and "May 6" in IST/JST → hydration mismatch.
                new Date(rfp.bid_close_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })
              : time.label}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Sealed bids
          </span>
          <span className="flex items-center gap-1.5 font-mono text-base font-semibold tabular-nums">
            {rfp.bid_count}
            <ArrowUpRightIcon className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
          </span>
        </div>
      </div>
    </Link>
  );
}
