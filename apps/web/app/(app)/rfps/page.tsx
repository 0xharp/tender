import Link from 'next/link';

import { RfpCard } from '@/components/rfp/rfp-card';
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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            open rfps
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Browse open RFPs</h1>
        </div>
        <Link
          href="/rfps/new"
          className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
        >
          Post RFP
        </Link>
      </header>

      {error && (
        <div className="rounded border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load RFPs: {error.message}
        </div>
      )}

      {rfps && rfps.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No open RFPs yet. Be the first —{' '}
            <Link href="/rfps/new" className="font-medium text-foreground underline">
              post one
            </Link>
            .
          </p>
        </div>
      )}

      {rfps && rfps.length > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {rfps.map((r) => (
            <RfpCard key={r.on_chain_pda} rfp={r} />
          ))}
        </div>
      )}
    </main>
  );
}
