import { GavelIcon, LockKeyholeIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ReserveTagProps {
  /** Whether a reserve commitment exists on-chain. */
  hasReserve: boolean;
  /** If reserve has been revealed (post-award), the value in USDC base units (micro). */
  revealedMicroUsdc?: bigint;
  size?: 'sm' | 'md';
  className?: string;
}

function formatUsdc(micro: bigint): string {
  const whole = Number(micro / 1_000_000n);
  return `$${whole.toLocaleString('en-US')}`;
}

/**
 * Visible whenever an RFP has a reserve commitment on chain. Two states:
 *  - sealed (pre-award): "Reserve set" - value is hidden
 *  - revealed (post-award): "Reserve $X" - value is visible
 *
 * The reserve is enforced by `select_bid` (rejects winning bids over the
 * revealed amount). Providers see only that one exists, not the value -
 * that's the point: it caps without anchoring bidding behavior to the cap.
 */
export function ReserveTag({
  hasReserve,
  revealedMicroUsdc,
  size = 'sm',
  className,
}: ReserveTagProps) {
  if (!hasReserve) return null;

  const revealed = typeof revealedMicroUsdc === 'bigint' && revealedMicroUsdc > 0n;
  const Icon = revealed ? GavelIcon : LockKeyholeIcon;
  const label = revealed ? `Reserve ${formatUsdc(revealedMicroUsdc!)}` : 'Reserve set';
  const hint = revealed
    ? 'Buyer revealed their reserve at award time. Winning bid was within it.'
    : 'Buyer committed to a maximum acceptable price (sealed). Bids above it will be rejected at award. The value is revealed only when the buyer awards.';

  return (
    <span
      title={hint}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium tracking-[0.12em] uppercase',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
        revealed
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
          : 'border-amber-500/20 bg-amber-500/5 text-amber-700/90 dark:text-amber-400/90',
        className,
      )}
    >
      <Icon className={size === 'sm' ? 'size-3' : 'size-3.5'} />
      {label}
    </span>
  );
}
