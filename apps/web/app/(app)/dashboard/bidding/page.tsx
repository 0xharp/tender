import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { ProviderBidsPanel } from '@/components/rfp/provider-bids-panel';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function DashboardBidding() {
  const wallet = (await getCurrentWallet()) as string;
  const supabase = await serverSupabase();

  const [{ count: rfpsPosted }, { count: bidsCommitted }] = await Promise.all([
    supabase
      .from('rfps')
      .select('*', { count: 'exact', head: true })
      .eq('buyer_wallet', wallet),
    supabase
      .from('bid_ciphertexts')
      .select('*', { count: 'exact', head: true })
      .eq('provider_wallet', wallet),
  ]);

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfpsPosted ?? 0 },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCommitted ?? 0 },
  ];

  return (
    <DashboardShell
      title="Bids you've committed"
      description="Sealed by default. Reveal in browser memory with a single wallet signature."
      tabs={tabs}
      activeHref="/dashboard/bidding"
      actions={
        <Link
          href={`/providers/${wallet}`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-9 gap-2 rounded-full px-4',
          )}
        >
          Public profile <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      <ProviderBidsPanel profileWallet={wallet} />
    </DashboardShell>
  );
}
