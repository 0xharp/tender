import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { SectionHeader } from '@/components/primitives/section-header';
import { RfpCard } from '@/components/rfp/rfp-card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const supabase = await serverSupabase();
  const { data: rfps, error } = await supabase
    .from('rfps')
    .select(
      'on_chain_pda, title, category, scope_summary, budget_max_usdc, bid_close_at, bid_count, status',
    )
    .in('status', ['open', 'reveal'])
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Marketplace"
        title="Browse open RFPs"
        description="Sealed-bid procurement requests from crypto-native organizations. Submit a bid and the plaintext stays in your browser."
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
          Failed to load RFPs: {error.message}
        </div>
      )}

      {rfps && rfps.length === 0 && (
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

      {rfps && rfps.length > 0 && (
        <Stagger
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          step={0.05}
          delay={0.1}
        >
          {rfps.map((r) => (
            <StaggerItem key={r.on_chain_pda}>
              <RfpCard rfp={r} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </main>
  );
}
