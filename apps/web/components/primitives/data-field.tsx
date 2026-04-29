import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DataFieldProps {
  label: string;
  value: ReactNode;
  /** Render label small-caps with letter-spacing (default true). */
  caps?: boolean;
  /** Render in mono with tabular-nums (default true). */
  mono?: boolean;
  /** Layout: `inline` row (default for short values) or `stacked` column. */
  layout?: 'inline' | 'stacked';
  /** Right-align the value. */
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Standard label/value row. Replaces the ad-hoc `flex items-baseline justify-between gap-3 font-mono text-xs`
 * pattern repeated across the codebase. Used inside detail panels for things like
 * "bid PDA · {addr}", "commit hash · {hash}", "submitted · {timestamp}".
 */
export function DataField({
  label,
  value,
  caps = true,
  mono = true,
  layout = 'inline',
  align = 'right',
  className,
}: DataFieldProps) {
  return (
    <div
      className={cn(
        layout === 'inline'
          ? 'flex items-baseline justify-between gap-3'
          : 'flex flex-col gap-1',
        className,
      )}
    >
      <span
        className={cn(
          'text-xs text-muted-foreground',
          caps && 'text-[10px] font-medium uppercase tracking-[0.14em]',
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'min-w-0 break-all text-foreground',
          mono ? 'font-mono text-xs tabular-nums' : 'text-sm',
          layout === 'inline' && align === 'right' && 'text-right',
        )}
      >
        {value}
      </span>
    </div>
  );
}
