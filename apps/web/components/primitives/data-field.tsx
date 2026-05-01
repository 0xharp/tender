import { InfoIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface DataFieldProps {
  label: string;
  value: ReactNode;
  /** Optional tooltip content shown on hover/focus of an info icon next to the label. */
  hint?: ReactNode;
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
  hint,
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
          'inline-flex items-center gap-1 text-xs text-muted-foreground',
          caps && 'text-[10px] font-medium uppercase tracking-[0.14em]',
        )}
      >
        {label}
        {hint && (
          <Tooltip>
            <TooltipTrigger
              render={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label={`Info about ${label}`}
                  className="inline-flex cursor-help items-center text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <InfoIcon className="size-3" />
                </button>
              )}
            />
            <TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
              {hint}
            </TooltipContent>
          </Tooltip>
        )}
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
