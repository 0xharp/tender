import { ArrowUpRightIcon, BoxIcon, CalendarRangeIcon, KeyRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { type StatusTone, StatusPill } from '@/components/primitives/status-pill';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

function formatBudget(usdc: string): string {
  const n = Number(usdc);
  if (Number.isNaN(n)) return `${usdc} USDC`;
  return `$${n.toLocaleString('en-US')}`;
}

function statusTone(status: string): StatusTone {
  if (status === 'open') return 'open';
  if (status === 'reveal') return 'reveal';
  if (status === 'awarded') return 'awarded';
  return 'closed';
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
        <div className="rounded-xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load RFP: {error.message}
        </div>
      </main>
    );
  }
  if (!rfp) notFound();

  const isBuyer = wallet === rfp.buyer_wallet;
  const isOpenForBids = rfp.status === 'open' && new Date(rfp.bid_close_at).getTime() > Date.now();
  const milestones = rfp.milestone_template;

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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow={`RFP · ${rfp.category.replace(/_/g, ' ')}`}
        title={rfp.title}
        size="md"
        actions={
          <StatusPill tone={statusTone(rfp.status)}>{rfp.status}</StatusPill>
        }
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="text-base">Scope</CardTitle>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              buyer · <HashLink hash={rfp.buyer_wallet} kind="account" visibleChars={4} />
            </span>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-7 text-foreground/90">
              {rfp.scope_summary}
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <BoxIcon className="size-3.5" />
                Budget cap
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">
                {formatBudget(rfp.budget_max_usdc)}
                <span className="ml-1.5 text-base font-normal text-muted-foreground">USDC</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {rfp.bid_count} {rfp.bid_count === 1 ? 'sealed bid' : 'sealed bids'} committed
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <CalendarRangeIcon className="size-3.5" />
                Lifecycle
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <LifecycleStep
                index={1}
                title="Bidding"
                description="Providers submit ECIES-encrypted bids."
                from={rfp.bid_open_at}
                to={rfp.bid_close_at}
              />
              <div className="border-t border-border" />
              <LifecycleStep
                index={2}
                title="Reveal & select"
                description="Buyer decrypts in browser, picks a winner."
                from={rfp.bid_close_at}
                to={rfp.reveal_close_at}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between">
          <CardTitle className="text-base">Milestones</CardTitle>
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            {milestones.length} steps
          </span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {milestones.map((m, i) => (
            <div
              key={`${i}-${m.name}`}
              className="flex flex-col gap-2 rounded-xl border border-dashed border-border/60 bg-card/40 p-3 transition-colors hover:border-border hover:bg-card"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{m.name}</p>
                <span className="font-mono text-xs text-primary tabular-nums">{m.percentage}%</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">{m.description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-card via-card to-primary/5">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 -right-8 size-40 rounded-full bg-primary/15 blur-3xl"
        />
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRoundIcon className="size-4 text-primary" />
              {isBuyer ? 'Your RFP' : isOpenForBids ? 'Submit a sealed bid' : 'Bidding closed'}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {isBuyer
                ? 'Bid review opens when the reveal window starts. You will sign once to derive your RFP keypair and decrypt all bids in browser memory.'
                : isOpenForBids
                  ? 'Your bid is encrypted to the buyer’s pubkey before commit. Other providers see only a 32-byte hash.'
                  : 'No new bids accepted. Reveal phase has begun or the RFP has expired.'}
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="font-mono text-sm tabular-nums text-foreground">
            {rfp.bid_count}{' '}
            <span className="text-xs text-muted-foreground">
              {rfp.bid_count === 1 ? 'committed' : 'committed'}
            </span>
          </div>
          {isOpenForBids && !isBuyer && (
            <Link
              href={`/rfps/${id}/bid`}
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-11 gap-2 rounded-full px-6 shadow-md shadow-primary/25',
              )}
            >
              {viewerHasBid ? 'Manage your bid' : 'Submit sealed bid'}
              <ArrowUpRightIcon className="size-3.5" />
            </Link>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain references</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DataField label="RFP PDA" value={<HashLink hash={rfp.on_chain_pda} kind="account" />} />
          {rfp.tx_signature && (
            <DataField
              label="create tx"
              value={<HashLink hash={rfp.tx_signature} kind="tx" />}
            />
          )}
          <DataField
            label="program"
            value={<HashLink hash={TENDER_PROGRAM_ID} kind="account" />}
          />
        </CardContent>
      </Card>
    </main>
  );
}

function LifecycleStep({
  index,
  title,
  description,
  from,
  to,
}: {
  index: number;
  title: string;
  description: string;
  from: string;
  to: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-6 flex-shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-[10px] tabular-nums text-muted-foreground">
        {index}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          <LocalTime iso={from} /> → <LocalTime iso={to} />
        </p>
      </div>
    </div>
  );
}
