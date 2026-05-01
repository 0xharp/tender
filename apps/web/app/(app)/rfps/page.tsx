import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { SectionHeader } from '@/components/primitives/section-header';
import { RfpCard } from '@/components/rfp/rfp-card';
import { buttonVariants } from '@/components/ui/button';
import {
  bidderVisibilityToString,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Read both sources in parallel: on-chain Rfp accounts (status, windows,
  // bid_count, etc.) + supabase metadata (title, scope_summary). Join by
  // on_chain_pda. On-chain is the source of truth — supabase rows that don't
  // have a matching on-chain account are skipped (stale).
  const supabase = await serverSupabase();
  const [chainRfpsResult, metaResult] = await Promise.all([
    listRfps(),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary, milestone_template, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  const error = metaResult.error;
  const metaByPda = new Map((metaResult.data ?? []).map((r) => [r.on_chain_pda, r]));

  // Filter to active marketplace (open + reveal). Status comes from on-chain.
  const cards = chainRfpsResult
    .map(({ address, data }) => {
      const meta = metaByPda.get(address);
      if (!meta) return null;
      return {
        on_chain_pda: address,
        title: meta.title,
        category: 'engineering', // category is on-chain (u8); kept generic in card for now
        scope_summary: meta.scope_summary,
        budget_max_usdc: microUsdcToDecimal(data.budgetMax),
        bid_close_at: unixSecondsToIso(data.bidCloseAt),
        bid_count: data.bidCount,
        status: rfpStatusToString(data.status),
        bidder_visibility: bidderVisibilityToString(data.bidderVisibility),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null && (c.status === 'open' || c.status === 'reveal'));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Marketplace"
        title="Browse open RFPs"
        description="Sealed-bid procurement requests from crypto-native organizations. Bids are sealed cryptographically until the bid window closes — even from the buyer."
        actions={
          <Link
            href="/rfps/new"
            className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-2 rounded-full px-4')}
          >
            New RFP <ArrowUpRightIcon className="size-3.5" />
          </Link>
        }
      />

      {error && (
        <div className="rounded-xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load RFP metadata: {error.message}
        </div>
      )}

      {cards.length === 0 && !error && (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 p-12 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            empty marketplace
          </div>
          <p className="max-w-md text-sm text-muted-foreground">
            No open RFPs yet. Be the first to post — the on-chain account is created in a single
            transaction.
          </p>
          <Link
            href="/rfps/new"
            className={cn(buttonVariants({ size: 'lg' }), 'h-11 gap-2 rounded-full px-6')}
          >
            Post the first RFP <ArrowUpRightIcon className="size-3.5" />
          </Link>
        </div>
      )}

      {cards.length > 0 && (
        <Stagger
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          step={0.05}
          delay={0.1}
        >
          {cards.map((r) => (
            <StaggerItem key={r.on_chain_pda}>
              <RfpCard rfp={r} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </main>
  );
}
