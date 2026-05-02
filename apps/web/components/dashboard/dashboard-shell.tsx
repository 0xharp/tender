import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface DashboardTab {
  href: string;
  label: string;
  count?: number;
}

export function DashboardShell({
  title,
  description,
  tabs,
  activeHref,
  actions,
  children,
}: {
  title: string;
  description?: string;
  tabs?: DashboardTab[];
  activeHref?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4 border-b border-border/60 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Workspace
          </span>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {title}
          </h1>
          {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>

      {tabs && tabs.length > 0 && (
        <nav
          className="-mx-1 flex items-center gap-1 overflow-x-auto"
          aria-label="Workspace sections"
        >
          {tabs.map((tab) => {
            const active = activeHref === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'group inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-all',
                  active
                    ? 'border-primary/40 bg-primary/10 text-foreground shadow-sm shadow-primary/10'
                    : 'border-transparent text-muted-foreground hover:border-border/60 hover:bg-card hover:text-foreground',
                )}
              >
                {tab.label}
                {typeof tab.count === 'number' && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] tabular-nums',
                      active
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground group-hover:bg-card',
                    )}
                  >
                    {tab.count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="flex flex-col gap-6">{children}</div>
    </div>
  );
}
