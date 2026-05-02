import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type StatusTone = 'open' | 'reveal' | 'awarded' | 'closed' | 'sealed' | 'live' | 'neutral';

const TONE_STYLES: Record<StatusTone, string> = {
  open: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  reveal: 'border-primary/40 bg-primary/15 text-primary',
  awarded: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
  closed: 'border-border bg-muted/60 text-muted-foreground',
  sealed: 'border-primary/40 bg-primary/10 text-primary',
  live: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  neutral: 'border-border bg-card/60 text-muted-foreground',
};

const TONE_DOT: Record<StatusTone, string> = {
  open: 'bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60',
  reveal: 'bg-primary shadow-[0_0_8px] shadow-primary/60',
  awarded: 'bg-fuchsia-500 shadow-[0_0_8px] shadow-fuchsia-500/60',
  closed: 'bg-muted-foreground',
  sealed: 'bg-primary shadow-[0_0_8px] shadow-primary/60',
  live: 'bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60',
  neutral: 'bg-muted-foreground',
};

export interface StatusPillProps {
  tone: StatusTone;
  /** Show the leading status dot (default true). */
  dot?: boolean;
  /** Compact size - smaller padding + text. */
  size?: 'sm' | 'md';
  /** Render UPPERCASE with wide tracking (default true). */
  caps?: boolean;
  children: ReactNode;
  className?: string;
}

export function StatusPill({
  tone,
  dot = true,
  size = 'sm',
  caps = true,
  children,
  className,
}: StatusPillProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs',
        caps && 'tracking-[0.14em] uppercase',
        TONE_STYLES[tone],
        className,
      )}
    >
      {dot && <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  );
}
