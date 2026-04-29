import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { RfpCard } from '@/components/rfp/rfp-card';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function DashboardBuying() {
  const wallet = (await getCurrentWallet()) as string;
  const supabase = await serverSupabase();

  const { data: rfps, error } = await supabase
    .from('rfps')
    .select(
      'on_chain_pda, title, category, scope_summary, budget_max_usdc, bid_close_at, bid_count, status',
    )
    .eq('buyer_wallet', wallet)
    .order('created_at', { ascending: false });

  const { count: bidsCount } = await supabase
    .from('bid_ciphertexts')
    .select('*', { count: 'exact', head: true })
    .eq('provider_wallet', wallet);

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfps?.length ?? 0 },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCount ?? 0 },
  ];

  return (
    <DashboardShell
      title="RFPs you've posted"
      description="Every RFP you've created, in any state. Open, in reveal, awarded, or closed."
      tabs={tabs}
      activeHref="/dashboard/buying"
      actions={
        <Link
          href="/rfps/new"
          className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-2 rounded-full px-4')}
        >
          New RFP <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      {error && (
        <div className="rounded-xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load: {error.message}
        </div>
      )}

      {rfps && rfps.length === 0 && <EmptyBuying />}

      {rfps && rfps.length > 0 && (
        <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2" step={0.05} delay={0.1}>
          {rfps.map((r) => (
            <StaggerItem key={r.on_chain_pda}>
              <RfpCard rfp={r} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </DashboardShell>
  );
}

function EmptyBuying() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 p-12 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        no RFPs yet
      </div>
      <p className="max-w-md text-sm text-muted-foreground">
        Posting an RFP derives an RFP-specific X25519 keypair from your wallet signature, mints
        the on-chain account, and opens it for sealed bids.
      </p>
      <Link
        href="/rfps/new"
        className={cn(buttonVariants({ size: 'lg' }), 'h-11 gap-2 rounded-full px-6')}
      >
        Post your first RFP <ArrowUpRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}
