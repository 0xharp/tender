import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { type Address } from '@solana/kit';
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
import {
  bidderVisibilityToString,
  fetchRfp,
  listBids,
  microUsdcToDecimal,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
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
  const wallet = await getCurrentWallet();
  const supabase = await serverSupabase();

  // On-chain Rfp account is authoritative for status/windows/identity/budget;
  // supabase row holds title/scope/milestones (the human-readable text).
  const [chainRfp, metaResult] = await Promise.all([
    fetchRfp(id as Address),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary, milestone_template, tx_signature, created_at')
      .eq('on_chain_pda', id)
      .maybeSingle(),
  ]);

  if (metaResult.error) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="rounded-xl border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load RFP metadata: {metaResult.error.message}
        </div>
      </main>
    );
  }
  if (!chainRfp || !metaResult.data) notFound();
  const meta = metaResult.data;

  const status = rfpStatusToString(chainRfp.status);
  const visibility = bidderVisibilityToString(chainRfp.bidderVisibility);
  const buyerWallet = chainRfp.buyer;
  const bidOpenAtIso = unixSecondsToIso(chainRfp.bidOpenAt);
  const bidCloseAtIso = unixSecondsToIso(chainRfp.bidCloseAt);
  const revealCloseAtIso = unixSecondsToIso(chainRfp.revealCloseAt);
  const budgetUsdc = microUsdcToDecimal(chainRfp.budgetMax);
  const bidCount = chainRfp.bidCount;
  const milestones = meta.milestone_template;

  const isBuyer = wallet === buyerWallet;
  const isOpenForBids = status === 'open' && new Date(bidCloseAtIso).getTime() > Date.now();

  // Has the viewer already bid here? Check on-chain BidCommit accounts.
  let viewerHasBid = false;
  if (wallet && !isBuyer) {
    const walletAddr = wallet as Address;
    const walletHash = sha256(bs58.decode(wallet));
    const [l0Match, l1Match] = await Promise.all([
      listBids({ rfpPda: id as Address, providerWallet: walletAddr }),
      listBids({ rfpPda: id as Address, providerWalletHash: walletHash }),
    ]);
    viewerHasBid = l0Match.length + l1Match.length > 0;
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="RFP"
        title={meta.title}
        size="md"
        actions={
          <div className="flex items-center gap-2">
            <StatusPill tone={statusTone(status)}>{status}</StatusPill>
            {visibility === 'buyer_only' && (
              <StatusPill tone="sealed">private bidders</StatusPill>
            )}
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="text-base">Scope</CardTitle>
            <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              buyer · <HashLink hash={buyerWallet} kind="account" visibleChars={4} />
            </span>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm leading-7 text-foreground/90">
              {meta.scope_summary}
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
                {formatBudget(budgetUsdc)}
                <span className="ml-1.5 text-base font-normal text-muted-foreground">USDC</span>
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {bidCount} {bidCount === 1 ? 'sealed bid' : 'sealed bids'} committed
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
                from={bidOpenAtIso}
                to={bidCloseAtIso}
              />
              <div className="border-t border-border" />
              <LifecycleStep
                index={2}
                title="Reveal & select"
                description="Buyer decrypts in browser, picks a winner."
                from={bidCloseAtIso}
                to={revealCloseAtIso}
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
            {bidCount}{' '}
            <span className="text-xs text-muted-foreground">committed</span>
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
          <DataField label="RFP PDA" value={<HashLink hash={meta.on_chain_pda} kind="account" />} />
          {meta.tx_signature && (
            <DataField
              label="create tx"
              value={<HashLink hash={meta.tx_signature} kind="tx" />}
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
