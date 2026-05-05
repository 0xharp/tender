'use client';

/**
 * Drawer that shows the FULL plaintext of a single decrypted bid.
 *
 * Why this exists: the buyer-bid-decryption-panel renders bid rows with
 * `line-clamp-3` on the scope so a long bid doesn't dominate the list.
 * Without an expand affordance the buyer was making award decisions on
 * truncated text. This drawer is the "see everything" escape hatch:
 *   - full scope rendered as markdown (bids can be markdown-drafted via
 *     the AI flow or by the provider directly)
 *   - every milestone with name / amount / duration
 *   - payout address + bid PDA
 *
 * Side-sheet pattern (right side, ~max-w-md) so the buyer can keep the
 * bid list visible behind the sheet for quick comparison.
 */

import { CalendarRangeIcon, CheckCircle2Icon, CoinsIcon } from 'lucide-react';

import { HashLink } from '@/components/primitives/hash-link';
import { PrivacyTag } from '@/components/primitives/privacy-tag';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { InlineMarkdown } from '@/components/ui/markdown';
import type { SealedBidPlaintext } from '@/lib/bids/schema';

export interface BidDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bidPda: string;
  isPrivate: boolean;
  plaintext: SealedBidPlaintext;
  /** Optional: when present, drawer surfaces an "Award this bid" button
   *  in the footer. Caller is responsible for the actual award flow. */
  onAward?: () => void;
  awarding?: boolean;
  awardDisabled?: boolean;
}

export function BidDetailDrawer({
  open,
  onOpenChange,
  bidPda,
  isPrivate,
  plaintext,
  onAward,
  awarding,
  awardDisabled,
}: BidDetailDrawerProps) {
  const totalMilestoneAmount = plaintext.milestones.reduce(
    (acc, m) => acc + Number(m.amountUsdc),
    0,
  );
  const totalDuration = plaintext.milestones.reduce(
    (acc, m) => acc + m.durationDays,
    0,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        <SheetHeader className="shrink-0 border-b border-border/40">
          <SheetTitle className="flex items-center gap-2 text-base">
            Bid detail
            <PrivacyTag mode={isPrivate ? 'buyer_only' : 'public'} size="sm" iconless />
          </SheetTitle>
          <SheetDescription className="font-mono text-[11px]">
            <HashLink hash={bidPda} kind="account" visibleChars={8} />
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {/* Top stats: price + timeline at-a-glance. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 p-3">
              <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <CoinsIcon className="size-3" />
                Price
              </span>
              <span className="font-mono text-xl font-semibold tabular-nums">
                ${Number(plaintext.priceUsdc).toLocaleString()}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 p-3">
              <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <CalendarRangeIcon className="size-3" />
                Timeline
              </span>
              <span className="font-mono text-xl font-semibold tabular-nums">
                {plaintext.timelineDays}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  day{plaintext.timelineDays === 1 ? '' : 's'}
                </span>
              </span>
            </div>
          </div>

          {/* Scope — full markdown render. */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Scope
            </h3>
            <div className="rounded-lg border border-border/60 bg-card/40 p-3">
              <InlineMarkdown
                source={plaintext.scope}
                className="flex flex-col gap-2 text-xs"
              />
            </div>
          </section>

          {/* Milestone breakdown. */}
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Milestones · {plaintext.milestones.length}
              </h3>
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                Σ ${totalMilestoneAmount.toLocaleString()} · {totalDuration}d
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {plaintext.milestones.map((m, i) => (
                <li
                  key={`${bidPda}-m-${i}`}
                  className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xs font-medium">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {i + 1}.
                      </span>{' '}
                      {m.name}
                    </span>
                    <div className="flex items-baseline gap-3 font-mono text-[11px] tabular-nums">
                      <span>${Number(m.amountUsdc).toLocaleString()}</span>
                      <span className="text-muted-foreground">{m.durationDays}d</span>
                    </div>
                  </div>
                  {m.description && (
                    <p className="text-[11px] leading-relaxed text-foreground/80">
                      {m.description}
                    </p>
                  )}
                  {m.successCriteria && (
                    <p className="text-[11px] italic leading-relaxed text-muted-foreground">
                      Acceptance: {m.successCriteria}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {/* Payout target + any extra notes. */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Payout
            </h3>
            <div className="rounded-lg border border-border/60 bg-card/40 p-3 font-mono text-[11px]">
              <HashLink hash={plaintext.payoutPreference.address} kind="account" visibleChars={10} />
            </div>
            {plaintext.notes && (
              <p className="rounded-lg border border-border/60 bg-card/40 p-3 text-[11px] leading-relaxed text-foreground/80">
                {plaintext.notes}
              </p>
            )}
          </section>
        </div>

        {onAward && (
          <SheetFooter className="shrink-0 border-t border-border/40 p-4">
            <Button
              type="button"
              size="sm"
              disabled={awardDisabled || awarding}
              onClick={onAward}
              className="w-full gap-1.5 rounded-full"
            >
              <CheckCircle2Icon className="size-3.5" />
              {awarding
                ? 'Awarding…'
                : `Award this bid · lock $${Number(plaintext.priceUsdc).toLocaleString()}`}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
