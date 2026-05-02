import type { Address } from '@solana/kit';
import { BoxIcon, CalendarRangeIcon } from 'lucide-react';
import { notFound } from 'next/navigation';

import { BuyerActionPanel, type MilestoneSummary } from '@/components/escrow/buyer-action-panel';
import { ProviderActionPanel } from '@/components/escrow/provider-action-panel';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { PrivacyTag } from '@/components/primitives/privacy-tag';
import { ReserveTag } from '@/components/primitives/reserve-tag';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { RfpLifecycleBar } from '@/components/rfp/rfp-lifecycle-bar';
import { SweepEphemeralPanel } from '@/components/rfp/sweep-ephemeral-panel';
import { YourBidPanel } from '@/components/rfp/your-bid-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import {
  bidderVisibilityToString,
  bytesToHex as bytesToHexNoble,
  fetchMilestones,
  fetchRfp,
  listBids,
  microUsdcToDecimal,
  milestoneStatusToString,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
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
  if (status === 'bidsclosed' || status === 'bid window closed') return 'sealed';
  return 'closed';
}

/** Match the marketplace card display: when on-chain status is still "open"
 *  but the bid window has expired (no one called rfp_close_bidding yet),
 *  surface a friendlier "bid window closed" label so the buyer/observer
 *  doesn't see a misleading "open" badge. */
function displayStatus(status: string, bidCloseAtIso: string): string {
  const closed = new Date(bidCloseAtIso).getTime() <= Date.now();
  if (status === 'open' && closed) return 'bid window closed';
  return status;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const wallet = await getCurrentWallet();
  const supabase = await serverSupabase();

  // On-chain Rfp account is authoritative for status/windows/identity/budget +
  // milestone count/percentages (after award). Supabase only holds the
  // human-readable scope text. Milestone names live inside the encrypted
  // winning-bid envelope and are decryptable by the buyer + winner only.
  const [chainRfp, metaResult] = await Promise.all([
    fetchRfp(id as Address),
    supabase
      .from('rfps')
      .select('on_chain_pda, rfp_nonce_hex, title, scope_summary, tx_signature, created_at')
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
  const bidCount = chainRfp.bidCount;
  const contractValueUsdc = microUsdcToDecimal(chainRfp.contractValue);
  const reserveRevealedUsdc = chainRfp.reservePriceRevealed
    ? microUsdcToDecimal(chainRfp.reservePriceRevealed)
    : '0';
  const hasReserve = !chainRfp.reservePriceCommitment.every((b: number) => b === 0);

  const isBuyer = wallet === buyerWallet;
  const isOpenForBids = status === 'open' && new Date(bidCloseAtIso).getTime() > Date.now();
  // chainRfp.winner / .winnerProvider are kit's Option<Address> wrapper:
  //   { __option: 'Some'; value: Address } | { __option: 'None' }
  // String()-ing the wrapper yields "[object Object]" (15 chars) which then
  // trips kit's address-length validator downstream. Unwrap to T | null.
  const winnerProvider =
    chainRfp.winnerProvider?.__option === 'Some'
      ? String(chainRfp.winnerProvider.value)
      : null;
  const winnerBidPda =
    chainRfp.winner?.__option === 'Some' ? String(chainRfp.winner.value) : null;
  const fundingDeadlineIso =
    chainRfp.fundingDeadline > 0n ? unixSecondsToIso(chainRfp.fundingDeadline) : null;

  // Pull milestones (after funding) + bid list (for buyer's close-bidding +
  // award picker). The buyer needs the bid list as soon as bidding is past
  // its close time (to flip status), and throughout the reveal+award phases.
  const [milestonesRaw, bidsForAward] = await Promise.all([
    chainRfp.milestoneCount > 0
      ? fetchMilestones(id as Address, chainRfp.milestoneCount)
      : Promise.resolve([]),
    isBuyer
      ? listBids({ rfpPda: id as Address })
      : Promise.resolve([] as Awaited<ReturnType<typeof listBids>>),
  ]);

  const milestoneSummaries: MilestoneSummary[] = milestonesRaw
    .map((m, i): MilestoneSummary | null => {
      if (!m) return null;
      return {
        index: i,
        amount: m.amount,
        status: milestoneStatusToString(m.status),
        iterationCount: m.iterationCount,
        reviewDeadlineIso: m.reviewDeadline > 0n ? unixSecondsToIso(m.reviewDeadline) : null,
        deliveryDeadlineIso: m.deliveryDeadline > 0n ? unixSecondsToIso(m.deliveryDeadline) : null,
        disputeDeadlineIso: m.disputeDeadline > 0n ? unixSecondsToIso(m.disputeDeadline) : null,
        buyerProposedSplitBps: m.buyerProposedSplitBps,
        providerProposedSplitBps: m.providerProposedSplitBps,
      };
    })
    .filter((m): m is MilestoneSummary => m != null);

  const bidsForAwardPanel = bidsForAward.map((b) => ({
    address: b.address,
    commitHashHex: bytesToHexNoble(new Uint8Array(b.data.commitHash)),
    submittedAtIso: unixSecondsToIso(b.data.submittedAt),
  }));
  const isPastBidClose = new Date(bidCloseAtIso).getTime() <= Date.now();

  // Has the viewer already bid here?
  // Public RFPs: bid.provider == viewer's main wallet → direct on-chain lookup
  //   resolves it server-side (zero popups, full bid details to the panel).
  // Private RFPs: bid.provider == ephemeral wallet (deterministic from main +
  //   rfp_pda). Detecting it server-side would require a wallet popup, so we
  //   defer to the client panel (localStorage cache hits zero popups in the
  //   common case; cache miss surfaces a "Check on-chain" button).
  let viewerExistingBid: {
    bidPda: string;
    submittedAt: string;
  } | null = null;
  if (wallet && !isBuyer && visibility === 'public') {
    const matches = await listBids({ rfpPda: id as Address, providerWallet: wallet as Address });
    const found = matches[0];
    if (found) {
      viewerExistingBid = {
        bidPda: found.address,
        submittedAt: unixSecondsToIso(found.data.submittedAt),
      };
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="RFP"
        title={meta.title}
        size="md"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={statusTone(displayStatus(status, bidCloseAtIso))}>
              {displayStatus(status, bidCloseAtIso)}
            </StatusPill>
            <PrivacyTag mode={visibility} />
            <ReserveTag hasReserve={hasReserve} revealedMicroUsdc={chainRfp.reservePriceRevealed} />
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
                Contract value
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">
                {chainRfp.contractValue > 0n ? formatBudget(contractValueUsdc) : '-'}
                {chainRfp.contractValue > 0n ? (
                  <span className="ml-1.5 text-base font-normal text-muted-foreground">USDC</span>
                ) : null}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {chainRfp.contractValue > 0n
                  ? 'Locked into escrow at award time.'
                  : 'Set when the buyer awards a winning bid.'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {bidCount} {bidCount === 1 ? 'sealed bid' : 'sealed bids'} committed
                {chainRfp.reservePriceRevealed > 0n ? (
                  <> · reserve revealed: ${reserveRevealedUsdc} USDC</>
                ) : null}
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
            <CardContent>
              <RfpLifecycleBar
                status={status}
                bidOpenAtIso={bidOpenAtIso}
                bidCloseAtIso={bidCloseAtIso}
                revealCloseAtIso={revealCloseAtIso}
                fundingDeadlineIso={fundingDeadlineIso}
                milestoneCount={chainRfp.milestoneCount}
                milestonesSettled={milestoneSummaries.filter(
                  (m) =>
                    m.status === 'released' ||
                    m.status === 'cancelledbybuyer' ||
                    m.status === 'disputeresolved' ||
                    m.status === 'disputedefault',
                ).length}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ---- Provider's bid on this RFP (canonical management surface) --- */}
      {!isBuyer && (
        <YourBidPanel
          rfpId={id}
          rfpPda={id}
          bidderVisibility={visibility}
          isBuyer={isBuyer}
          isOpenForBids={isOpenForBids}
          existingBid={viewerExistingBid}
        />
      )}

      {/* ---- Provider-side ephemeral sweep - surfaces only when there's a
              cached ephemeral with > 0.015 SOL ------------------------------ */}
      {!isBuyer && <SweepEphemeralPanel rfpPda={id} bidderVisibility={visibility} />}

      {/* ---- Role-aware action panels (escrow + milestones) ----------------- */}
      {isBuyer && (
        <BuyerActionPanel
          rfpPda={id}
          rfpStatus={status}
          rfpNonceHex={meta.rfp_nonce_hex}
          feeBps={chainRfp.feeBps}
          contractValueUsdc={contractValueUsdc}
          contractValueRaw={chainRfp.contractValue}
          milestoneCount={chainRfp.milestoneCount}
          milestoneAmounts={chainRfp.milestoneAmounts
            .slice(0, chainRfp.milestoneCount)
            .map((v) => BigInt(v))}
          milestoneDurationsSecs={chainRfp.milestoneDurationsSecs
            .slice(0, chainRfp.milestoneCount)
            .map((v) => BigInt(v))}
          winnerBidPda={winnerBidPda}
          fundingDeadlineIso={fundingDeadlineIso}
          milestones={milestoneSummaries}
          winnerProvider={winnerProvider}
          bids={bidsForAwardPanel}
          isPastBidClose={isPastBidClose}
        />
      )}

      {!isBuyer && winnerProvider && (
        <ProviderActionPanel
          rfpPda={id}
          rfpStatus={status}
          buyerWallet={buyerWallet}
          winnerBidPda={winnerBidPda}
          winnerProvider={winnerProvider}
          milestoneCount={chainRfp.milestoneCount}
          milestones={milestoneSummaries}
          activeMilestoneIndex={chainRfp.activeMilestoneIndex}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain references</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <DataField label="RFP PDA" value={<HashLink hash={meta.on_chain_pda} kind="account" />} />
          {meta.tx_signature && (
            <DataField label="create tx" value={<HashLink hash={meta.tx_signature} kind="tx" />} />
          )}
          <DataField label="program" value={<HashLink hash={TENDER_PROGRAM_ID} kind="account" />} />
        </CardContent>
      </Card>
    </main>
  );
}

