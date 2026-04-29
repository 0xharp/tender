import Link from 'next/link';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface RfpCardData {
  on_chain_pda: string;
  title: string;
  category: string;
  scope_summary: string;
  budget_max_usdc: string;
  bid_close_at: string;
  bid_count: number;
}

function formatBudget(usdc: string): string {
  const n = Number(usdc);
  if (Number.isNaN(n)) return `${usdc} USDC`;
  return `$${n.toLocaleString('en-US')} USDC`;
}

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'closed';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function RfpCard({ rfp }: { rfp: RfpCardData }) {
  return (
    <Link href={`/rfps/${rfp.on_chain_pda}`} className="block transition-colors">
      <Card className="hover:border-foreground/30">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              {rfp.category.replace('_', ' ')}
            </p>
            <CardTitle className="text-base">{rfp.title}</CardTitle>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            <span className="text-sm font-semibold">{formatBudget(rfp.budget_max_usdc)}</span>
            <span className="text-xs text-muted-foreground">{timeLeft(rfp.bid_close_at)}</span>
          </div>
        </CardHeader>
        <CardContent>
          <p className="line-clamp-2 text-sm text-muted-foreground">{rfp.scope_summary}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            {rfp.bid_count} {rfp.bid_count === 1 ? 'bid' : 'bids'} committed
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
