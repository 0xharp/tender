import { LockKeyholeIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ReserveTagProps {
  /** Whether a reserve commitment exists on-chain. */
  hasReserve: boolean;
  /** Kept in the prop signature for backwards-compat (RfpCardData still
   *  passes it from the chain). v2: we deliberately DO NOT surface the
   *  revealed amount in the UI — `reveal_reserve` runs at award time on
   *  chain so `select_bid` can enforce the cap, but we don't want to
   *  visually expose the buyer's max to observers. The badge is now a
   *  single state ("Reserve set") regardless of revealed status. */
  revealedMicroUsdc?: bigint;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Visible whenever an RFP has a reserve commitment on chain. Single
 * state — icon-only badge with hover tooltip. The actual reserve value
 * is enforced on chain (select_bid rejects winning bids above it) but
 * never surfaced in the UI; that keeps the buyer's cap private even
 * after the reveal_reserve tx lands. Matches the icon-only PrivacyBadges
 * styling so the privacy + reserve row stays compact + glanceable.
 */
export function ReserveTag({
  hasReserve,
  revealedMicroUsdc: _revealedMicroUsdc,
  size = 'sm',
  className,
}: ReserveTagProps) {
  if (!hasReserve) return null;

  const tooltip =
    'Reserve set — buyer committed to a maximum acceptable price. Bids above it are rejected at award. The value stays sealed in the UI even after on-chain reveal.';
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-700/90 transition-colors hover:bg-amber-500/15 dark:text-amber-400/90',
        size === 'sm' ? 'size-5' : 'size-6',
        className,
      )}
    >
      <LockKeyholeIcon className={size === 'sm' ? 'size-3' : 'size-3.5'} />
    </span>
  );
}
