import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { type Address } from '@solana/kit';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { RfpCard } from '@/components/rfp/rfp-card';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import {
  bidderVisibilityToString,
  listBids,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function DashboardBuying() {
  const wallet = (await getCurrentWallet()) as string;
  const walletAddr = wallet as Address;

  // On-chain reads + supabase metadata join. listRfps with the buyer filter
  // hits getProgramAccounts with a memcmp at offset 8 (buyer pubkey).
  const supabase = await serverSupabase();
  const walletHash = sha256(bs58.decode(wallet));
  const [chainRfps, l0Bids, l1Bids, metaResult] = await Promise.all([
    listRfps({ buyer: walletAddr }),
    listBids({ providerWallet: walletAddr }),
    listBids({ providerWalletHash: walletHash }),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary, milestone_template, created_at')
      .order('created_at', { ascending: false }),
  ]);

  const error = metaResult.error;
  const metaByPda = new Map((metaResult.data ?? []).map((r) => [r.on_chain_pda, r]));
  const bidsCount = l0Bids.length + l1Bids.length;

  const rfps = chainRfps
    .map(({ address, data }) => {
      const meta = metaByPda.get(address);
      if (!meta) return null;
      return {
        on_chain_pda: address,
        title: meta.title,
        category: 'engineering',
        scope_summary: meta.scope_summary,
        budget_max_usdc: microUsdcToDecimal(data.budgetMax),
        bid_close_at: unixSecondsToIso(data.bidCloseAt),
        bid_count: data.bidCount,
        status: rfpStatusToString(data.status),
        bidder_visibility: bidderVisibilityToString(data.bidderVisibility),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfps.length },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCount },
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
          Failed to load metadata: {error.message}
        </div>
      )}

      {rfps.length === 0 && !error && <EmptyBuying />}

      {rfps.length > 0 && (
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
