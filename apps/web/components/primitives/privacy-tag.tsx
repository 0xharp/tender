import { LockKeyholeIcon, ShieldCheckIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export type PrivacyMode = 'public' | 'buyer_only';

export interface PrivacyTagProps {
  mode: PrivacyMode;
  /** Compact (sm) or default (md) sizing. */
  size?: 'sm' | 'md';
  /** Hide the icon - use when stacked next to other pills. */
  iconless?: boolean;
  className?: string;
}

const COPY: Record<PrivacyMode, { title: string; short: string }> = {
  public: {
    title: 'Bid Content Private',
    short: 'Bid contents stay sealed until award. Bidder wallets are public.',
  },
  buyer_only: {
    title: 'Bid Content + Identity Private',
    short:
      'Bid contents AND bidder identity stay sealed. Bids are signed by per-RFP ephemeral wallets.',
  },
};

export function PrivacyTag({ mode, size = 'sm', iconless = false, className }: PrivacyTagProps) {
  const { title } = COPY[mode];
  const Icon = mode === 'public' ? ShieldCheckIcon : LockKeyholeIcon;
  return (
    <span
      title={COPY[mode].short}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium tracking-[0.12em] uppercase',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
        mode === 'public'
          ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300'
          : 'border-primary/40 bg-primary/10 text-primary',
        className,
      )}
    >
      {!iconless && <Icon className={size === 'sm' ? 'size-3' : 'size-3.5'} />}
      {title}
    </span>
  );
}

/** One-line marketing-y explanation, used inline on the create form etc. */
export function privacyTagShort(mode: PrivacyMode): string {
  return COPY[mode].short;
}
