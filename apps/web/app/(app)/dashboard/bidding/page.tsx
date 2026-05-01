import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { type Address } from '@solana/kit';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { ProviderBidsPanel } from '@/components/rfp/provider-bids-panel';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { listBids, listRfps } from '@/lib/solana/chain-reads';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardBidding() {
  const wallet = (await getCurrentWallet()) as string;
  const walletAddr = wallet as Address;
  const walletHash = sha256(bs58.decode(wallet));

  // Counts come from on-chain getProgramAccounts.
  const [myRfps, l0Bids, l1Bids] = await Promise.all([
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
    listBids({ providerWalletHash: walletHash }),
  ]);
  const rfpsPosted = myRfps.length;
  const bidsCommitted = l0Bids.length + l1Bids.length;

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfpsPosted },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCommitted },
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
