/**
 * Phased lifecycle indicator for the RFP detail sidebar.
 *
 * Shows the project's full journey as a horizontal progress bar with discrete
 * phase markers. The current phase is highlighted (animated dot); past phases
 * show a check; future phases are muted. Terminal-failure states (cancelled /
 * ghosted / disputed) replace the trailing phases when they apply.
 *
 * Phase derivation: (rfp.status, time) → current phase index. We don't trust
 * status alone because RFPs can be past `bid_close_at` while still on-chain
 * `Open` (until someone calls `rfp_close_bidding`).
 */
import { CheckIcon, InfoIcon } from 'lucide-react';
import Link from 'next/link';
import { Fragment } from 'react';

import { LocalTime } from '@/components/local-time';
import { cn } from '@/lib/utils';

export interface RfpLifecycleBarProps {
  status: string; // rfpStatusToString
  bidOpenAtIso: string;
  bidCloseAtIso: string;
  revealCloseAtIso: string;
  fundingDeadlineIso: string | null;
  /** total milestones (post-award only). 0 pre-award. */
  milestoneCount: number;
  /** how many milestones have terminally settled (Released / CancelledByBuyer
   *  / DisputeResolved / DisputeDefault). Pre-award = 0. */
  milestonesSettled: number;
}

type Phase = {
  key: string;
  label: string;
  /** Optional sub-label rendered under the marker (e.g. deadline). */
  hint?: React.ReactNode;
};

// Single-word labels keep each one on one line so the text centroid sits
// right under the dot. The two-word originals ("Reveal & select" / "In
// progress") wrapped inside their grid cells and looked off-center.
const HAPPY_PATH: Phase[] = [
  { key: 'bidding', label: 'Bidding' },
  { key: 'reveal', label: 'Reveal' },
  { key: 'awarded', label: 'Awarded' },
  { key: 'funded', label: 'Funded' },
  { key: 'inprogress', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

/**
 * Map (status, time) → current phase index in HAPPY_PATH. Returns -1 for
 * terminal-failure states (rendered separately below).
 */
function currentPhaseIndex(
  status: string,
  bidCloseAtIso: string,
  revealCloseAtIso: string,
  milestoneCount: number,
  milestonesSettled: number,
): {
  idx: number;
  failure?: 'cancelled' | 'ghostedbybuyer' | 'disputed' | 'reveallapsed' | 'expired';
} {
  if (status === 'cancelled') return { idx: -1, failure: 'cancelled' };
  if (status === 'ghostedbybuyer') return { idx: -1, failure: 'ghostedbybuyer' };
  if (status === 'disputed') return { idx: -1, failure: 'disputed' };
  // `expired` is the terminal on-chain state set by expire_rfp after the
  // reveal window lapses. Surfaces as a failure tile - lifecycle is over.
  if (status === 'expired') return { idx: -1, failure: 'expired' };

  // Reveal-window-lapsed: buyer didn't call expire_rfp yet, so on-chain status
  // is still Reveal/BidsClosed even though the program would now block any
  // award. Synthesized failure tile that prompts the expire_rfp action; once
  // someone fires it, status flips to `expired` and the branch above catches it.
  const revealExpired = new Date(revealCloseAtIso).getTime() <= Date.now();
  if ((status === 'reveal' || status === 'bidsclosed') && revealExpired) {
    return { idx: -1, failure: 'reveallapsed' };
  }

  if (status === 'open') {
    // Past close → bidding window has expired but no one has called close_bidding yet.
    // Display as "between bidding and reveal" - current marker stays on Bidding,
    // but bar visually shows it as transitioning.
    return { idx: 0 };
  }
  if (status === 'bidsclosed') return { idx: 1 };
  if (status === 'reveal') return { idx: 1 };
  if (status === 'awarded') return { idx: 2 };
  if (status === 'funded') return { idx: 3 };
  if (status === 'inprogress') {
    // If all milestones settled but status hasn't auto-flipped yet → completed
    if (milestoneCount > 0 && milestonesSettled >= milestoneCount) return { idx: 5 };
    return { idx: 4 };
  }
  if (status === 'completed') return { idx: 5 };
  void bidCloseAtIso;
  return { idx: 0 };
}

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  cancelled: {
    title: 'Cancelled',
    body: 'Every milestone was refunded - no work was delivered. Buyer kept the full contract value; provider received nothing. Terminal state.',
  },
  ghostedbybuyer: {
    title: 'Ghosted by buyer',
    body: 'Buyer awarded a winner but never funded within the funding window.',
  },
  disputed: {
    title: 'Disputed',
    body: 'A milestone is in dispute. Resolution pending.',
  },
  reveallapsed: {
    title: 'Reveal window lapsed',
    body: "Buyer didn't pick a winner before the reveal deadline. The RFP is dead - bidders' funds were never locked, no on-chain award is possible anymore.",
  },
  expired: {
    title: 'Expired',
    body: 'The reveal window closed without an award. The RFP was permissionlessly marked expired - terminal state.',
  },
};

export function RfpLifecycleBar({
  status,
  bidOpenAtIso,
  bidCloseAtIso,
  revealCloseAtIso,
  fundingDeadlineIso,
  milestoneCount,
  milestonesSettled,
}: RfpLifecycleBarProps) {
  const { idx, failure } = currentPhaseIndex(
    status,
    bidCloseAtIso,
    revealCloseAtIso,
    milestoneCount,
    milestonesSettled,
  );

  if (failure) {
    const f = FAILURE_COPY[failure]!;
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <p className="font-medium text-destructive">{f.title}</p>
        <p className="text-muted-foreground">{f.body}</p>
      </div>
    );
  }

  const total = HAPPY_PATH.length;
  // Progress bar fill = idx / (total - 1) so the leading edge of the fill
  // sits EXACTLY at the current dot's center. The fill goes through past
  // dots and stops at the current one - the ping animation on the current
  // dot signals "you are here."
  // Special case: if we're on Bidding but past bid_close, push the fill a
  // small amount past the dot so it visually leans toward Reveal.
  const isPastBidClose = status === 'open' && new Date(bidCloseAtIso).getTime() <= Date.now();
  const progressUnits = idx + (isPastBidClose ? 0.4 : 0);
  const progressPct = Math.min(100, (progressUnits / (total - 1)) * 100);
  // Each label cell is `100/total`% wide, so the bar's left/right inset is
  // `100 / (2 * total)`% (= half a cell on each side, putting the bar between
  // the column centers of the first and last cells).
  const barInsetPct = 100 / (2 * total);

  return (
    <div className="flex flex-col gap-3">
      {/* CSS-Grid lifecycle: each column owns one phase. The dot + the
          alternating label live inside the same column, so they ALWAYS line
          up vertically. The bar is positioned absolutely across the dots'
          centers (insets = half a cell on each side). */}
      <div
        className="relative grid items-center"
        style={{
          gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))`,
          gridTemplateRows: 'auto 16px auto',
          rowGap: '8px',
        }}
      >
        {/* The bar - sits in the middle row, spans column 1 → column N at
            their CENTERS via percentage insets. */}
        <div
          className="pointer-events-none absolute"
          style={{
            left: `${barInsetPct}%`,
            right: `${barInsetPct}%`,
            top: '50%',
            transform: 'translateY(-50%)',
          }}
        >
          <div className="relative h-1 rounded-full bg-border">
            <div
              className="absolute inset-y-0 left-0 h-1 rounded-full bg-primary transition-all duration-500"
              style={{
                // progressPct is in 0..100 across the FULL phase span (idx 0..total-1).
                // Since the bar already spans only the inter-dot region, we map
                // 1:1 here - 0% = first dot, 100% = last dot.
                width: `${progressPct}%`,
              }}
            />
          </div>
        </div>

        {HAPPY_PATH.map((phase, i) => {
          const past = i < idx;
          const current = i === idx;
          const above = i % 2 === 0;
          return (
            <Fragment key={phase.key}>
              {/* Top label (even indices) */}
              <span
                className={cn(
                  'flex items-end justify-center text-center text-[10px] uppercase leading-tight tracking-wider',
                  current && 'font-medium text-foreground',
                  !current && 'text-muted-foreground/70',
                )}
                style={{ gridColumn: i + 1, gridRow: 1, visibility: above ? 'visible' : 'hidden' }}
              >
                {above ? phase.label : phase.label /* placeholder for layout */}
              </span>

              {/* The dot (middle row) */}
              <span
                className="relative flex items-center justify-center"
                style={{ gridColumn: i + 1, gridRow: 2 }}
              >
                <span
                  className={cn(
                    'relative flex size-4 items-center justify-center rounded-full border-2 transition-all',
                    past && 'border-primary bg-primary text-primary-foreground',
                    current &&
                      'border-primary bg-background ring-2 ring-primary/30 ring-offset-1 ring-offset-background',
                    !past && !current && 'border-border bg-background',
                  )}
                  title={phase.label}
                >
                  {past && <CheckIcon className="size-2.5" />}
                  {current && (
                    <>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
                    </>
                  )}
                </span>
              </span>

              {/* Bottom label (odd indices) */}
              <span
                className={cn(
                  'flex items-start justify-center text-center text-[10px] uppercase leading-tight tracking-wider',
                  current && 'font-medium text-foreground',
                  !current && 'text-muted-foreground/70',
                )}
                style={{ gridColumn: i + 1, gridRow: 3, visibility: above ? 'hidden' : 'visible' }}
              >
                {above ? '' : phase.label}
              </span>
            </Fragment>
          );
        })}
      </div>

      {/* Time hints - show only the most relevant deadline given current phase */}
      <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border/60 bg-card/40 p-2.5 text-[11px] text-muted-foreground">
        {idx === 0 && (
          <>
            <Hint label="Bidding closes">
              <LocalTime iso={bidCloseAtIso} compact />
            </Hint>
            <Hint label="Award by">
              <LocalTime iso={revealCloseAtIso} compact />
            </Hint>
            {isPastBidClose && (
              <p className="text-amber-700 dark:text-amber-400">
                Bid window expired - buyer can flip to reveal.
              </p>
            )}
          </>
        )}
        {idx === 1 && (
          <Hint label="Award by">
            <LocalTime iso={revealCloseAtIso} compact />
          </Hint>
        )}
        {idx === 2 && fundingDeadlineIso && (
          <Hint label="Fund by">
            <LocalTime iso={fundingDeadlineIso} compact />
          </Hint>
        )}
        {(idx === 3 || idx === 4) && milestoneCount > 0 && (
          <Hint label="Milestones">
            {milestonesSettled} / {milestoneCount} settled
          </Hint>
        )}
        {idx === 5 && <p>All milestones released or refunded. Project is done.</p>}
        <Link
          href="/docs/lifecycle"
          className="mt-1 inline-flex items-center gap-1 self-start text-[10px] text-muted-foreground/80 underline underline-offset-2 hover:text-foreground"
        >
          <InfoIcon className="size-3" /> How does this lifecycle work?
        </Link>
      </div>
      <span className="sr-only">Bid window opened {bidOpenAtIso}</span>
    </div>
  );
}

function Hint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono uppercase tracking-wider">{label}</span>
      <span className="font-mono">{children}</span>
    </div>
  );
}
