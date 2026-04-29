import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { type StatusTone, StatusPill } from '@/components/primitives/status-pill';
import { cn } from '@/lib/utils';

export interface RfpCardData {
  on_chain_pda: string;
  title: string;
  category: string;
  scope_summary: string;
  budget_max_usdc: string;
  bid_close_at: string;
  bid_count: number;
  status?: string;
}

function formatBudget(usdc: string): string {
  const n = Number(usdc);
  if (Number.isNaN(n)) return `${usdc} USDC`;
  return `$${n.toLocaleString('en-US')}`;
}

function timeLeft(iso: string): { label: string; tone: 'normal' | 'urgent' | 'closed' } {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { label: 'closed', tone: 'closed' };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { label: `${hours}h left`, tone: 'urgent' };
  return { label: `${Math.floor(hours / 24)}d left`, tone: 'normal' };
}

function statusTone(status?: string): StatusTone {
  if (status === 'open') return 'open';
  if (status === 'reveal') return 'reveal';
  if (status === 'awarded') return 'awarded';
  if (status === 'closed') return 'closed';
  return 'open';
}

export function RfpCard({ rfp }: { rfp: RfpCardData }) {
  const time = timeLeft(rfp.bid_close_at);

  return (
    <Link
      href={`/rfps/${rfp.on_chain_pda}`}
      className={cn(
        'group relative flex h-full flex-col gap-4 overflow-hidden rounded-2xl border border-border/60 bg-card p-5 transition-all',
        'hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
      />

      <div className="flex items-start justify-between gap-3">
        <StatusPill tone={statusTone(rfp.status)}>{rfp.status ?? 'open'}</StatusPill>
        <span
          className={cn(
            'font-mono text-[10px] tabular-nums uppercase tracking-wider',
            time.tone === 'urgent' && 'text-amber-600 dark:text-amber-400',
            time.tone !== 'urgent' && 'text-muted-foreground',
          )}
        >
          {time.label}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {rfp.category.replace(/_/g, ' ')}
        </span>
        <h3 className="font-display text-lg font-semibold leading-tight tracking-tight text-foreground transition-colors group-hover:text-primary">
          {rfp.title}
        </h3>
        <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
          {rfp.scope_summary}
        </p>
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-border/60 pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Budget cap
          </span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {formatBudget(rfp.budget_max_usdc)}
            <span className="ml-1 text-[11px] font-normal text-muted-foreground">USDC</span>
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Sealed bids
          </span>
          <span className="flex items-center gap-1.5 font-mono text-base font-semibold tabular-nums">
            {rfp.bid_count}
            <ArrowUpRightIcon className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" />
          </span>
        </div>
      </div>
    </Link>
  );
}
