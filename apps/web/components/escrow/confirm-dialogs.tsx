'use client';

/**
 * Confirmation dialogs for irreversible escrow actions:
 *  - AwardConfirmDialog: shown before award + fund (locks contract value)
 *  - CancelMilestoneDialog: shown before cancel-with-notice or cancel-with-penalty
 *
 * Each surfaces the exact math (amounts, penalties, refunds, fees) AND the
 * cancellation policy so the buyer understands the exit options before
 * committing.
 */
import { CheckCircle2Icon, GavelIcon, KeyRoundIcon, ShieldAlertIcon } from 'lucide-react';
import { useState } from 'react';

import { HashLink } from '@/components/primitives/hash-link';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/* -------------------------------------------------------------------------- */
/* AwardConfirmDialog                                                          */
/* -------------------------------------------------------------------------- */

export interface AwardConfirmPayload {
  bidPda: string;
  contractValueUsdc: string;
  milestones: { name: string; amountUsdc: string }[];
  payoutWallet: string;
  /** For private bids: the bid signer (ephemeral wallet) is different from the
   *  main wallet. Both shown so the buyer sees the binding decrypted from
   *  `_bidBinding.mainWallet`. */
  bidSignerWallet: string;
  isPrivate: boolean;
  feeBps: number;
}

export interface AwardConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: AwardConfirmPayload | null;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}

function fmtUsdc(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function AwardConfirmDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
  busy,
}: AwardConfirmDialogProps) {
  const [confirming, setConfirming] = useState(false);

  if (!pending) return null;
  const feePct = (pending.feeBps / 100).toFixed(pending.feeBps % 100 === 0 ? 1 : 2);
  const netRatio = (10_000 - pending.feeBps) / 10_000;
  const totalNet = (Number(pending.contractValueUsdc) * netRatio).toFixed(2);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4 text-primary" />
            Award winner and lock funds
          </DialogTitle>
          <DialogDescription>
            One transaction does the whole award atomically: reveal the reserve (if set), record the
            winner on chain, and transfer the contract value into escrow.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Money summary */}
          <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Lock into escrow
              </span>
              <span className="font-mono text-2xl font-semibold tabular-nums">
                ${fmtUsdc(pending.contractValueUsdc)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">USDC</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>Provider receives net</span>
              <span className="font-mono">
                ${fmtUsdc(totalNet)} (after {feePct}% platform fee)
              </span>
            </div>
          </div>

          {/* Milestones */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {pending.milestones.length} milestone{pending.milestones.length === 1 ? '' : 's'}
            </span>
            <ul className="flex flex-col gap-1 rounded-lg border border-dashed border-border/60 bg-card/40 p-2.5 text-xs">
              {pending.milestones.map((m, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span>
                    <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>{' '}
                    {m.name}
                  </span>
                  <span className="font-mono tabular-nums">${fmtUsdc(m.amountUsdc)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Identity */}
          <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-card/40 p-3 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Payout to</span>
              {/* payoutWallet is the verified main wallet (winner_provider
                  post-binding-sig) - safe for SNS. */}
              <HashLink hash={pending.payoutWallet} kind="account" visibleChars={6} withSns />
            </div>
            {pending.isPrivate && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Bid signer (ephemeral)</span>
                {/* INTENTIONALLY NO withSns - this is a per-RFP ephemeral
                    wallet. Privacy invariant: never resolve SNS for ephemerals. */}
                <HashLink hash={pending.bidSignerWallet} kind="account" visibleChars={6} />
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Bid PDA</span>
              <HashLink hash={pending.bidPda} kind="account" visibleChars={6} />
            </div>
          </div>

          {/* Cancellation policy */}
          <div className="flex flex-col gap-1.5 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              Exit options after award
            </p>
            <p className="text-muted-foreground">
              You can cancel each milestone individually. Before the provider clicks{' '}
              <strong className="text-foreground">Start</strong>, cancel = full refund, no
              reputation impact. After they start, cancel costs a 50% penalty (paid to provider as
              ramp-down compensation, half refunded to you) and counts as a cancellation on your
              reputation.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={confirming || busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={confirming || busy} onClick={handleConfirm}>
            {confirming || busy ? 'Awarding…' : 'Award winner and lock funds'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* CancelMilestoneDialog                                                       */
/* -------------------------------------------------------------------------- */

export interface CancelMilestonePayload {
  index: number;
  amountUsdc: string;
  /** 'notice' = pre-start, full refund, no rep ding.
   *  'penalty' = post-start, 50/50 split, buyer rep ding.
   *  'late' = post-deadline, full refund, provider rep ding. */
  kind: 'notice' | 'penalty' | 'late';
}

export interface CancelMilestoneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: CancelMilestonePayload | null;
  onConfirm: () => void | Promise<void>;
  busy?: boolean;
}

export function CancelMilestoneDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
  busy,
}: CancelMilestoneDialogProps) {
  const [confirming, setConfirming] = useState(false);

  if (!pending) return null;
  const isNotice = pending.kind === 'notice';
  const isLate = pending.kind === 'late';
  const isPenalty = pending.kind === 'penalty';
  const half = (Number(pending.amountUsdc) / 2).toFixed(2);

  async function handleConfirm() {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
    }
  }

  // Pre-compute display strings per variant.
  const headerIcon = isPenalty ? (
    <ShieldAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
  ) : (
    <CheckCircle2Icon
      className={
        isLate
          ? 'size-4 text-emerald-600 dark:text-emerald-400'
          : 'size-4 text-emerald-600 dark:text-emerald-400'
      }
    />
  );
  const headerTitle = isPenalty
    ? 'Abort milestone (50% penalty)'
    : isLate
      ? 'Cancel late milestone (full refund)'
      : 'Cancel milestone';
  const refundAmount = isPenalty ? fmtUsdc(half) : fmtUsdc(pending.amountUsdc);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {headerIcon}
            {headerTitle}
          </DialogTitle>
          <DialogDescription>
            Milestone {pending.index + 1} · ${fmtUsdc(pending.amountUsdc)} USDC
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div
            className={
              isPenalty
                ? 'flex flex-col gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4'
                : 'flex flex-col gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4'
            }
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Refund to you
              </span>
              <span className="font-mono text-xl font-semibold tabular-nums">${refundAmount}</span>
            </div>
            {isPenalty && (
              <div className="flex items-baseline justify-between text-xs text-muted-foreground">
                <span>Penalty to provider (compensation)</span>
                <span className="font-mono">${fmtUsdc(half)}</span>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground flex items-center gap-1.5">
              <GavelIcon className="size-3" /> Reputation impact
            </p>
            <p className="mt-1 text-muted-foreground">
              {isNotice &&
                "None. The provider hadn't started this milestone, so no work was wasted."}
              {isPenalty && (
                <>
                  Counts as <strong className="text-foreground">+1 cancellation</strong> on your
                  buyer reputation. The provider had ramped up; the penalty compensates them for the
                  context switch.
                </>
              )}
              {isLate && (
                <>
                  None on your end. The provider committed to a delivery deadline and missed it, so
                  they take the hit: <strong className="text-foreground">+1 late milestone</strong>{' '}
                  on their provider reputation. Visible to all future buyers.
                </>
              )}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={confirming || busy}
            onClick={() => onOpenChange(false)}
          >
            Keep milestone
          </Button>
          <Button
            variant={isPenalty ? 'destructive' : 'default'}
            disabled={confirming || busy}
            onClick={handleConfirm}
          >
            {confirming || busy
              ? 'Cancelling…'
              : isPenalty
                ? `Abort (penalty $${fmtUsdc(half)})`
                : isLate
                  ? 'Cancel late milestone (full refund)'
                  : 'Cancel milestone'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
