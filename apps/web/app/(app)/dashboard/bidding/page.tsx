import type { Address } from '@solana/kit';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { YourBidsList } from '@/components/rfp/your-bids-list';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { listBids, listRfps } from '@/lib/solana/chain-reads';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardBidding() {
  const wallet = (await getCurrentWallet()) as string;
  const walletAddr = wallet as Address;

  // Public-mode bids only - private bids are signed by per-RFP ephemeral
  // wallets that aren't enumerable from the main wallet (the privacy property).
  // They surface on the relevant RFP page once the provider verifies bidder
  // identity there.
  const [myRfps, ownBids] = await Promise.all([
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
  ]);
  const rfpsPosted = myRfps.length;
  const bidsCommitted = ownBids.length;

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfpsPosted },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCommitted },
  ];

  return (
    <DashboardShell
      title="Bids you've committed"
      description="One row per public-mode bid. Click through to manage (reveal · withdraw) on the RFP page."
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
      <YourBidsList
        bids={ownBids}
        emptyTitle="No public bids yet"
        emptyBody="Browse the marketplace and submit a sealed bid to see it here."
        notice={
          <>
            <strong className="text-foreground">Heads up:</strong> private-mode bids don't appear in
            this list - they're signed by per-RFP ephemeral wallets. Open the relevant RFP page and
            click "Check on-chain" to surface them.
          </>
        }
      />
    </DashboardShell>
  );
}
