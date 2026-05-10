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

import { CloakMark } from '@/components/nav/powered-by-logos';
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
  /** v2: when true, the connected buyer is the HD-private buyer for this
   *  RFP (rfp.buyer is an HD ephemeral). Drives the Cloak shielded-pool
   *  hint banner so the user understands why this flow takes ~90s + the
   *  one wallet popup is a Cloak deposit, not a normal transfer. */
  isPrivateBuyer?: boolean;
  /** 'award' (default): full award + fund flow. 'fund': resume-funding
   *  flow where the winner is already on chain (status = Awarded) and
   *  this confirm only triggers fund_project. Adjusts copy + button label
   *  but keeps the identity / Cloak banner / cancellation policy
   *  sections so the buyer sees the same level of detail. */
  mode?: 'award' | 'fund';
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

  const mode = pending.mode ?? 'award';
  const isFundOnly = mode === 'fund';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4 text-primary" />
            {isFundOnly ? 'Resume funding' : 'Award winner and lock funds'}
          </DialogTitle>
          <DialogDescription>
            {isFundOnly ? (
              pending.isPrivateBuyer ? (
                <>
                  The winner is already recorded on chain. This step routes the contract value into
                  escrow <strong className="text-foreground">via Cloak's shielded pool</strong> so
                  your main wallet stays off-chain through funding.
                </>
              ) : (
                <>
                  The winner is already recorded on chain. This step transfers the contract value
                  into per-milestone escrow.
                </>
              )
            ) : pending.isPrivateBuyer ? (
              <>
                One click does the whole award: reveal reserve (if set), record the winner on chain,
                and route the contract value into escrow{' '}
                <strong className="text-foreground">via Cloak's shielded pool</strong> so your main
                wallet stays off-chain through funding.
              </>
            ) : (
              <>
                One transaction does the whole award atomically: reveal the reserve (if set), record
                the winner on chain, and transfer the contract value into escrow.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Cloak shielded-pool hint — private-buyer only. Sets expectations
              that the funding step is async (~90s end-to-end) and that the
              one wallet popup is a shielded deposit, not a vanilla transfer.
              Powered-by attribution lives at the bottom. */}
          {pending.isPrivateBuyer && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/5 p-3 text-xs leading-relaxed">
              <p className="flex items-center gap-1.5 font-medium text-fuchsia-700 dark:text-fuchsia-300">
                🔒 Funded via Cloak's shielded UTXO pool
              </p>
              <p className="text-muted-foreground">
                Your USDC moves{' '}
                <strong className="text-foreground">
                  main wallet → shielded pool → fresh HD funding ephemeral → escrow
                </strong>
                . The on-chain trail breaks inside the pool, so observers can't link the escrow's
                funder to your main wallet. You'll see
                <strong className="text-foreground"> one wallet popup</strong> (Cloak deposit);
                everything after signs locally with HD ephemerals. Total time ~90s.
              </p>
              <p className="text-[10px] text-muted-foreground">
                Devnet uses Cloak Mock USDC (
                <a
                  href="https://devnet.cloak.ag/privacy/faucet"
                  target="_blank"
                  rel="noreferrer"
                  className="text-fuchsia-700 underline-offset-2 hover:underline dark:text-fuchsia-300"
                >
                  faucet ↗
                </a>
                ). Top up if your main wallet is short.
              </p>
            </div>
          )}

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
                // biome-ignore lint/suspicious/noArrayIndexKey: milestones list is locked at award time, never reorders
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
                <span className="text-muted-foreground">Bid signer</span>
                {/* INTENTIONALLY NO withSns — this is a per-RFP ephemeral
                    wallet. ephemeralRole='provider' surfaces it as
                    "Anon Provider · {trunc}" instead of a bare hash so
                    the buyer immediately recognizes this as a private
                    bidder. */}
                <HashLink
                  hash={pending.bidSignerWallet}
                  kind="account"
                  visibleChars={6}
                  ephemeralRole="provider"
                />
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

        <DialogFooter className="flex flex-col gap-2 sm:flex-col sm:items-stretch">
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={confirming || busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={confirming || busy} onClick={handleConfirm}>
              {confirming || busy
                ? isFundOnly
                  ? 'Funding…'
                  : 'Awarding…'
                : isFundOnly
                  ? pending.isPrivateBuyer
                    ? 'Fund via Cloak'
                    : `Lock $${fmtUsdc(pending.contractValueUsdc)} USDC into escrow`
                  : pending.isPrivateBuyer
                    ? 'Award + fund via Cloak'
                    : 'Award winner and lock funds'}
            </Button>
          </div>
          {pending.isPrivateBuyer && (
            <p className="flex items-center justify-end gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              powered by
              <a
                href="https://cloak.ag"
                target="_blank"
                rel="noreferrer"
                aria-label="Cloak"
                className="inline-flex items-center text-foreground/80 transition-colors hover:text-foreground"
              >
                <CloakMark className="block h-3 w-auto" />
              </a>
            </p>
          )}
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
