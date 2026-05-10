import type { Address } from '@solana/kit';
import { BoxIcon, CalendarRangeIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BuyerActionPanel, type MilestoneSummary } from '@/components/escrow/buyer-action-panel';
import { ExpireRfpPanel } from '@/components/escrow/expire-rfp-panel';
import { ProviderActionPanel } from '@/components/escrow/provider-action-panel';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { PrivacyBadges } from '@/components/primitives/privacy-tag';
import { ReserveTag } from '@/components/primitives/reserve-tag';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { ShareCard } from '@/components/profile/share-card';
import { HdRoleSwitch } from '@/components/rfp/hd-role-switch';
import { RfpLifecycleBar } from '@/components/rfp/rfp-lifecycle-bar';
import { YourBidPanel } from '@/components/rfp/your-bid-panel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineMarkdown } from '@/components/ui/markdown';
import { getCurrentWallet } from '@/lib/auth/session';
import { stripMarkdown } from '@/lib/markdown/strip';
import { listMilestoneNotes } from '@/lib/milestones/notes-server';
import { RfpOgCard } from '@/lib/og/rfp-card';
import { buildRfpOgProps } from '@/lib/og/rfp-props';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  bidderVisibilityToString,
  buyerVisibilityToString,
  bytesToHex as bytesToHexNoble,
  fetchBuyerReputation,
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

export async function generateMetadata({ params }: PageProps) {
  // Per-RFP OpenGraph + Twitter title/description so a shared link reads
  // as the actual RFP rather than the generic site copy. Image itself
  // comes from the colocated `opengraph-image.tsx` route. Defensive: if
  // the RFP doesn't exist in supabase yet (race during create flow) we
  // fall through to the layout-level metadata.
  const { id } = await params;
  try {
    const supabase = await serverSupabase();
    const { data } = await supabase
      .from('rfps')
      .select('title, scope_summary')
      .eq('on_chain_pda', id)
      .maybeSingle();
    if (!data?.title) return {};
    const title = `${data.title} · tendr.bid`;
    // Strip markdown for OG/Twitter description so social previews don't
    // show literal `**` or heading hashes (those characters survive the
    // 180-char slice and look broken in social-card snippets).
    const plain = stripMarkdown(data.scope_summary ?? '');
    const description = plain
      ? `${plain.slice(0, 180)}${plain.length > 180 ? '…' : ''}`
      : 'Sealed-bid procurement RFP on Solana - bids stay private until the window closes.';
    return {
      title,
      description,
      openGraph: { title, description, type: 'article' as const },
      twitter: { title, description, card: 'summary_large_image' as const },
    };
  } catch {
    return {};
  }
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
  const buyerVisibility = buyerVisibilityToString(chainRfp.buyerVisibility);
  const isPrivateBuyer = buyerVisibility === 'private';
  const buyerWallet = chainRfp.buyer;
  // Buyer rep is fetched lazily here (not bundled in the initial Promise.all
  // above) because it's only needed for the inline trust badge in the Scope
  // card. If the rep account doesn't exist yet (buyer's first RFP, no awards
  // ever) the badge silently hides - cleaner than rendering "0 funded · 0
  // completed" which would imply the buyer had failed history.
  // buyerSlug is needed twice now: by the inline trust badge (via the
  // share-preview block below) and by the OG-card preview's buyerHandle.
  // Promise.all keeps the extra SNS read off the critical path.
  const [buyerRep, buyerSlug] = await Promise.all([
    fetchBuyerReputation(buyerWallet as Address),
    preferredProfileSlug(buyerWallet as Address),
  ]);
  const bidOpenAtIso = unixSecondsToIso(chainRfp.bidOpenAt);
  const bidCloseAtIso = unixSecondsToIso(chainRfp.bidCloseAt);
  const revealCloseAtIso = unixSecondsToIso(chainRfp.revealCloseAt);
  const bidCount = chainRfp.bidCount;
  const contractValueUsdc = microUsdcToDecimal(chainRfp.contractValue);
  // v2 — reserve_price_revealed is read on chain by select_bid to enforce
  // the cap, but we deliberately don't surface the revealed amount in the
  // UI. ReserveTag stays in the "Reserve set" state regardless.
  const hasReserve = !chainRfp.reservePriceCommitment.every((b: number) => b === 0);

  const isBuyer = wallet === buyerWallet;
  const isOpenForBids = status === 'open' && new Date(bidCloseAtIso).getTime() > Date.now();
  // chainRfp.winner / .winnerProvider are kit's Option<Address> wrapper:
  //   { __option: 'Some'; value: Address } | { __option: 'None' }
  // String()-ing the wrapper yields "[object Object]" (15 chars) which then
  // trips kit's address-length validator downstream. Unwrap to T | null.
  const winnerProvider =
    chainRfp.winnerProvider?.__option === 'Some' ? String(chainRfp.winnerProvider.value) : null;
  const winnerBidPda = chainRfp.winner?.__option === 'Some' ? String(chainRfp.winner.value) : null;
  const fundingDeadlineIso =
    chainRfp.fundingDeadline > 0n ? unixSecondsToIso(chainRfp.fundingDeadline) : null;

  // Pull milestones (after funding) + bid list (for buyer's close-bidding +
  // award picker). The buyer needs the bid list as soon as bidding is past
  // its close time (to flip status), and throughout the reveal+award phases.
  //
  // We fetch bids unconditionally — server-side `isBuyer` only matches
  // the main wallet, so for HD-private buyers (where `chainRfp.buyer`
  // is an HD ephemeral) the previous `isBuyer ? listBids : []` gate
  // resolved to an empty array and the BuyerActionPanel rendered
  // "Decrypt 0 bids". Bid PDAs + commit hashes are public chain data
  // anyway; only the encrypted envelope contents need the buyer's
  // X25519 key to decrypt, which happens client-side. The HdRoleSwitch
  // wrapper handles whether to actually mount BuyerActionPanel for
  // HD-buyer viewers.
  const [milestonesRaw, bidsForAward, milestoneNotes] = await Promise.all([
    chainRfp.milestoneCount > 0
      ? fetchMilestones(id as Address, chainRfp.milestoneCount)
      : Promise.resolve([]),
    listBids({ rfpPda: id as Address }),
    listMilestoneNotes(id),
  ]);

  // Group notes by milestone_index so each row can pluck its slice without
  // O(N*M) scans. Empty arrays for milestones with no notes simplify the
  // render path (component only renders when notes.length > 0).
  const notesByMilestoneIndex: Record<number, typeof milestoneNotes> = {};
  for (const n of milestoneNotes) {
    const arr = notesByMilestoneIndex[n.milestone_index] ?? [];
    arr.push(n);
    notesByMilestoneIndex[n.milestone_index] = arr;
  }

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
            <PrivacyBadges bidderVisibility={visibility} buyerVisibility={buyerVisibility} />
            <ReserveTag hasReserve={hasReserve} revealedMicroUsdc={chainRfp.reservePriceRevealed} />
          </div>
        }
      />

      <ShareCard
        shareHref={`/rfps/${id}`}
        shareText={`${meta.title} — sealed-bid RFP on @tendrdotbid. {url}`}
        ogImageUrl={`/api/og/rfp/${id}`}
        downloadFilename={`rfp-${id.slice(0, 8)}-tendr.bid.png`}
      >
        <RfpOgCard
          {...buildRfpOgProps({
            title: meta.title,
            buyerSlug,
            buyerWallet,
            contractValueMicroUsdc: chainRfp.contractValue,
            milestoneCount: chainRfp.milestoneCount,
            bidCount: chainRfp.bidCount,
            bidCloseAtIso,
            onChainStatus: status,
            privacyMode: visibility,
            buyerVisibility,
          })}
        />
      </ShareCard>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="text-base">Scope</CardTitle>
            <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              buyer ·{' '}
              {isPrivateBuyer ? (
                // v2 private-buyer mode: render via HashLink with
                // ephemeralRole='buyer' so the surface reads
                // "Anon Buyer · {trunc}" — consistent with every other
                // ephemeral surface on the app. The ephemeral pubkey is
                // technically public (it signed the RFP), but the
                // "Anon" prefix tells observers this is a per-RFP
                // identity not a clusterable persona. SNS resolution is
                // unconditionally suppressed by ephemeralRole.
                <HashLink
                  hash={buyerWallet}
                  kind="account"
                  visibleChars={4}
                  ephemeralRole="buyer"
                  copyable={false}
                  className="normal-case tracking-normal"
                />
              ) : (
                <HashLink
                  hash={buyerWallet}
                  kind="account"
                  visibleChars={4}
                  withSns
                  // Wrapper span sets `uppercase tracking-[0.16em]` for the
                  // label style; cancel both on the address itself so a `.sol`
                  // name renders as `sharpre.sol`, not `SHARPRE.SOL`, and the
                  // hash keeps its base58 case + spacing intact.
                  className="normal-case tracking-normal"
                />
              )}
              {/* Inline trust badge: signals to bidders whether the buyer
                  has a track record of funding + completing past RFPs.
                  Reads tone:
                  - green-ish: at least 1 funded + 0 ghosted
                  - amber: any ghosted_rfps > 0 (red flag for bidders)
                  - hidden: no rep account or zero-everything (don't pollute
                    a fresh wallet's profile with negative-by-default signals)
                  - hidden in private buyer mode: rep PDA is keyed on the
                    ephemeral, never read by anyone, so any number we
                    surfaced would be misleading. Buyer can opt-in to
                    public credit later via attest_buyer_history.
                  Click-through goes to the buyer's full profile. */}
              {!isPrivateBuyer &&
                buyerRep &&
                (buyerRep.fundedRfps > 0 || buyerRep.ghostedRfps > 0) && (
                  <Link
                    href={`/buyers/${buyerWallet}`}
                    className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/40 px-2 py-0.5 normal-case tracking-normal text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                    title="Buyer's on-chain track record"
                  >
                    <span className="text-foreground">{buyerRep.completedRfps}</span> completed ·{' '}
                    <span className="text-foreground">{buyerRep.fundedRfps}</span> funded
                    {buyerRep.ghostedRfps > 0 && (
                      <>
                        {' '}
                        ·{' '}
                        <span className="text-amber-600 dark:text-amber-400">
                          {buyerRep.ghostedRfps} ghosted
                        </span>
                      </>
                    )}
                  </Link>
                )}
              {isPrivateBuyer && (
                <span className="rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 normal-case tracking-normal text-primary">
                  no public rep · privacy-first
                </span>
              )}
            </span>
          </CardHeader>
          <CardContent>
            {/* scope_summary is now markdown-aware: buyers can drop AI-drafted
                markdown from the modal and it renders properly. Plain-text
                summaries from older RFPs still render fine (paragraphs). */}
            <InlineMarkdown source={meta.scope_summary} />
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
                milestonesSettled={
                  milestoneSummaries.filter(
                    (m) =>
                      m.status === 'released' ||
                      m.status === 'cancelledbybuyer' ||
                      m.status === 'disputeresolved' ||
                      m.status === 'disputedefault',
                  ).length
                }
              />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ---- Provider's bid on this RFP (canonical management surface) --- */}
      {/* Wrapped in HdRoleSwitch so HD buyers never see the bidder panel
          for their own RFP (the panel itself also has its own
          useIsHdBuyer guard, but this avoids even mounting it). */}
      <HdRoleSwitch
        rfpPda={id}
        serverIsBuyer={isBuyer}
        buyerSlot={null}
        notBuyerSlot={
          <YourBidPanel
            rfpId={id}
            rfpPda={id}
            bidderVisibility={visibility}
            isBuyer={isBuyer}
            isOpenForBids={isOpenForBids}
            existingBid={viewerExistingBid}
          />
        }
      />

      {/* ---- Reveal-window-expired escape hatch (permissionless) ------------ */}
      {/* Also surfaces a "no bids received — wait for reveal close" info card
          BEFORE the reveal window closes when bidCount === 0, so the buyer
          isn't staring at a "Decrypt bids / Award the winner" prompt with
          nothing to act on. */}
      <ExpireRfpPanel
        rfpPda={id}
        rfpStatus={status}
        revealCloseAtIso={revealCloseAtIso}
        buyerWallet={buyerWallet}
        bidCount={Number(bidCount)}
      />

      {/* v2: per-RFP sweep removed — global EphemeralBalancePanel on
          /me/projects covers all stranded ephemerals (buyer + bidder)
          across every private RFP/bid the keychain knows about. */}

      {/* ---- Role-aware action panels (escrow + milestones) ----------------- */}
      {/* Single client switch picks buyer vs provider panels based on
          merged main + HD buyer detection. HD buyers see BuyerActionPanel
          even though server-side `isBuyer` is false (chainRfp.buyer is
          their HD ephemeral, not their main wallet). */}
      <HdRoleSwitch
        rfpPda={id}
        serverIsBuyer={isBuyer}
        buyerSlot={
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
            notesByMilestoneIndex={notesByMilestoneIndex}
            rfpScope={meta.scope_summary ?? undefined}
            rfpTitle={meta.title}
            buyerVisibility={buyerVisibility}
            bidderVisibility={visibility}
          />
        }
        notBuyerSlot={
          winnerProvider ? (
            <ProviderActionPanel
              rfpPda={id}
              rfpStatus={status}
              buyerWallet={buyerWallet}
              winnerBidPda={winnerBidPda}
              winnerProvider={winnerProvider}
              milestoneCount={chainRfp.milestoneCount}
              milestones={milestoneSummaries}
              activeMilestoneIndex={chainRfp.activeMilestoneIndex}
              notesByMilestoneIndex={notesByMilestoneIndex}
            />
          ) : null
        }
      />

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
