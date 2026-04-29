import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { serverSupabase } from '@/lib/supabase/server';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatBudget(usdc: string): string {
  const n = Number(usdc);
  if (Number.isNaN(n)) return `${usdc} USDC`;
  return `$${n.toLocaleString('en-US')} USDC`;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;

  const [wallet, supabase] = await Promise.all([getCurrentWallet(), serverSupabase()]);
  const { data: rfp, error } = await supabase
    .from('rfps')
    .select('*')
    .eq('on_chain_pda', id)
    .maybeSingle();

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="rounded border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load RFP: {error.message}
        </div>
      </main>
    );
  }
  if (!rfp) notFound();

  const isBuyer = wallet === rfp.buyer_wallet;
  const isOpenForBids = rfp.status === 'open' && new Date(rfp.bid_close_at).getTime() > Date.now();
  const milestones = rfp.milestone_template;

  // Check whether the signed-in viewer is a provider who has already bid on this RFP.
  let viewerHasBid = false;
  if (wallet && !isBuyer) {
    const { data: existing } = await supabase
      .from('bid_ciphertexts')
      .select('id')
      .eq('rfp_id', rfp.id)
      .eq('provider_wallet', wallet)
      .maybeSingle();
    viewerHasBid = !!existing;
  }
  const solscanRfp = `https://solscan.io/account/${rfp.on_chain_pda}?cluster=devnet`;
  const solscanTx = rfp.tx_signature
    ? `https://solscan.io/tx/${rfp.tx_signature}?cluster=devnet`
    : null;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {rfp.category.replace('_', ' ')} · {rfp.status}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{rfp.title}</h1>
        <p className="font-mono text-xs text-muted-foreground">
          buyer: {rfp.buyer_wallet.slice(0, 4)}…{rfp.buyer_wallet.slice(-4)}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Scope</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-wrap text-sm leading-6">{rfp.scope_summary}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Budget cap</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{formatBudget(rfp.budget_max_usdc)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lifecycle</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div>
              <p className="font-medium">1. Bidding</p>
              <p className="text-xs text-muted-foreground">
                Providers submit sealed bids during this window.
              </p>
              <p className="mt-1">
                <LocalTime iso={rfp.bid_open_at} />
                <br />→ <LocalTime iso={rfp.bid_close_at} />
              </p>
            </div>
            <div className="border-t border-border pt-3">
              <p className="font-medium">2. Reveal & select</p>
              <p className="text-xs text-muted-foreground">
                Buyer decrypts bids and picks a winner before this deadline. If no winner is
                selected by then, the RFP expires.
              </p>
              <p className="mt-1">
                <LocalTime iso={rfp.bid_close_at} />
                <br />→ <LocalTime iso={rfp.reveal_close_at} />
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Milestones ({milestones.length})</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {milestones.map((m, i) => (
            <div
              key={`${i}-${m.name}`}
              className="flex items-start justify-between gap-4 rounded border border-dashed border-border p-3"
            >
              <div>
                <p className="text-sm font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">{m.description}</p>
              </div>
              <span className="font-mono text-xs">{m.percentage}%</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain references</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">RFP PDA</span>
            <Link
              href={solscanRfp}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs underline"
            >
              {rfp.on_chain_pda.slice(0, 8)}…{rfp.on_chain_pda.slice(-8)}
            </Link>
          </div>
          {solscanTx && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">create tx</span>
              <Link
                href={solscanTx}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs underline"
              >
                {rfp.tx_signature?.slice(0, 8)}…{rfp.tx_signature?.slice(-8)}
              </Link>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">program</span>
            <Link
              href={`https://solscan.io/account/${TENDER_PROGRAM_ID}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs underline"
            >
              {TENDER_PROGRAM_ID.slice(0, 8)}…{TENDER_PROGRAM_ID.slice(-8)}
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bids</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {rfp.bid_count} {rfp.bid_count === 1 ? 'bid' : 'bids'} committed.
          </p>
          {isOpenForBids && !isBuyer && (
            <Link
              href={`/rfps/${id}/bid`}
              className="inline-flex h-9 w-fit items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            >
              {viewerHasBid ? 'Manage your bid' : 'Submit a sealed bid'}
            </Link>
          )}
          {isBuyer && (
            <p className="text-xs text-muted-foreground">
              You posted this RFP. Bid review tools arrive when the reveal window opens.
            </p>
          )}
          {!isOpenForBids && !isBuyer && (
            <p className="text-xs text-muted-foreground">Bidding is closed for this RFP.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
