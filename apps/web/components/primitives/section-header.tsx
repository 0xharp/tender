import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface SectionHeaderProps {
  /** Mono small-caps eyebrow (e.g. "open RFPs", "workspace"). */
  eyebrow?: string;
  /** Display title (rendered with font-display + tracking-tight). */
  title: ReactNode;
  /** Body description below the title. */
  description?: ReactNode;
  /** Right-aligned actions (buttons / links). */
  actions?: ReactNode;
  /** Title size scale. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const TITLE_SIZE = {
  sm: 'text-2xl sm:text-3xl',
  md: 'text-3xl sm:text-4xl',
  lg: 'text-4xl sm:text-5xl',
};

/**
 * Standardized page / section header. Replaces the manually-coded eyebrow + h1
 * pattern repeated across browse / detail / dashboard pages.
 */
export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  size = 'md',
  className,
}: SectionHeaderProps) {
  return (
    <header
      className={cn('flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between', className)}
    >
      <div className="flex flex-col gap-2">
        {eyebrow && (
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </span>
        )}
        <h1
          className={cn(
            'font-display font-semibold leading-tight tracking-tight text-balance',
            TITLE_SIZE[size],
          )}
        >
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 sm:flex-shrink-0">{actions}</div>}
    </header>
  );
}
