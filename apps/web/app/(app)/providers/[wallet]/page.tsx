import type { Address } from '@solana/kit';
import { BriefcaseIcon, TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { ShareCard } from '@/components/profile/share-card';
import { YourBidsList } from '@/components/rfp/your-bids-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProfileOgCard } from '@/lib/og/profile-card';
import { preferredProfileSlug, resolveWalletParam } from '@/lib/sns/resolve-server';
import {
  fetchProviderReputation,
  listBids,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

// Mirror the formatting in `opengraph-image.tsx` so the in-page preview
// renders the exact stats X / Slack / Discord will see for this URL.
const fmtUsdShort = (microUsdc: bigint): string => {
  const usdc = Number(microUsdc) / 1_000_000;
  if (usdc >= 1_000_000) return `$${(usdc / 1_000_000).toFixed(1)}M`;
  if (usdc >= 1_000) return `$${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 1) return `$${usdc.toFixed(0)}`;
  return '$0';
};

const truncateForHero = (wallet: string): string =>
  wallet.length <= 9 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

interface PageProps {
  params: Promise<{ wallet: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  // Two jobs:
  // 1. Set <link rel="canonical"> at the pubkey URL so search engines +
  //    analytics dedupe `/providers/<sol>` and `/providers/<pubkey>` to
  //    one entry. Browser bar still shows whatever the user typed.
  // 2. Override the layout-level OpenGraph + Twitter title/description so
  //    a share-card on X / Slack / Discord reads `sharpre.sol on tendr.bid`
  //    instead of the generic site copy. The OG image itself comes from
  //    the colocated `opengraph-image.tsx` route.
  const { wallet: rawWallet } = await params;
  try {
    const pubkey = await resolveWalletParam(rawWallet);
    const slug = await preferredProfileSlug(pubkey);
    const handle = slug.endsWith('.sol') ? slug : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
    const title = `${handle} · provider on tendr.bid`;
    const description = `Public on-chain reputation for ${handle} - sealed-bid procurement on Solana.`;
    return {
      title,
      description,
      alternates: { canonical: `/providers/${pubkey}` },
      openGraph: { title, description, type: 'profile' as const },
      twitter: { title, description, card: 'summary_large_image' as const },
    };
  } catch {
    return {};
  }
}

export default async function Page({ params }: PageProps) {
  const { wallet: rawWallet } = await params;
  // Resolve `.sol → pubkey` (no-op for pubkey input). URL bar preserved
  // — page renders with the canonical pubkey internally.
  const wallet = await resolveWalletParam(rawWallet);
  const supabase = await serverSupabase();
  const walletAddr = wallet as Address;

  // Profile pages are pure-public — own-profile == visitor view. Owner-
  // only surfaces (Claim reputation CTA, ephemeral sweep) live on
  // /dashboard/bidding. Mirror of the buyer profile after the v2 cleanup;
  // dropping the `getCurrentWallet()` lookup keeps this surface free of
  // session-coupled branches and ensures observers see exactly what the
  // owner does.
  //
  // Bid count comes from on-chain (public-mode only). Private-mode bids
  // are signed by per-RFP ephemeral wallets and stay unlinkable to the
  // main wallet — losing private bids therefore don't surface here ever,
  // on purpose.
  //
  // Awarded RFPs surface ONLY for public bidder mode. v2 select_bid
  // writes `rfp.winner_provider = bid.provider`, which in private bidder
  // mode is the per-RFP ephemeral pubkey (NOT the main wallet). The
  // memcmp filter on `winner_provider` therefore matches public-mode
  // wins exclusively. Reputation counters from anonymous wins reach this
  // page only after the provider runs `attest_win` from Dashboard, which
  // merges the eph's ProviderReputation into the main wallet's PDA but
  // leaves `rfp.winner_provider` untouched.
  const [{ data: profile }, ownBids, providerRep, awardedRfps] = await Promise.all([
    supabase.from('providers').select('*').eq('wallet', wallet).maybeSingle(),
    listBids({ providerWallet: walletAddr }),
    fetchProviderReputation(walletAddr),
    listRfps({ winnerProvider: walletAddr }),
  ]);
  const count = ownBids.length;

  // Join supabase titles for the awarded RFPs so the card has readable labels.
  const awardedPdaList = awardedRfps.map((r) => r.address);
  const awardedTitlesQuery = awardedPdaList.length
    ? await supabase
        .from('rfps')
        .select('on_chain_pda, title, scope_summary')
        .in('on_chain_pda', awardedPdaList)
    : { data: [] as { on_chain_pda: string; title: string; scope_summary: string }[] };
  const titleByPda = new Map(
    (awardedTitlesQuery.data ?? []).map((r) => [r.on_chain_pda, r] as const),
  );

  // Group awarded RFPs by status so we render In progress vs Completed
  // separately — most useful framing for someone evaluating this provider.
  const awardedRows = awardedRfps
    .map((r) => {
      const status = rfpStatusToString(r.data.status);
      const meta = titleByPda.get(r.address);
      return {
        pda: r.address,
        title: meta?.title ?? null,
        status,
        contractValueMicroUsdc: r.data.contractValue,
        createdAt: Number(r.data.createdAt),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  const inProgressRows = awardedRows.filter(
    (r) => r.status === 'funded' || r.status === 'inprogress' || r.status === 'awarded',
  );
  const completedRows = awardedRows.filter((r) => r.status === 'completed');
  const otherRows = awardedRows.filter(
    (r) => !inProgressRows.includes(r) && !completedRows.includes(r),
  );

  // Use the .sol slug for the share/copy URL when this wallet has a primary
  // domain set. Same readability win as the leaderboard links: shared URLs
  // become /providers/sharpre.sol on X / clipboard, not the 44-char pubkey.
  const shareSlug = await preferredProfileSlug(wallet);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Public provider profile"
        // Title: custom display_name from supabase wins; then SNS handle;
        // then a generic "Anon Provider" fallback. No eph detection — the
        // page treats every URL as a main wallet (legacy private-bidder
        // ephs surface as their raw pubkey, accepted as a quirk of pre-v2
        // envelope data).
        title={profile?.display_name ?? (shareSlug.endsWith('.sol') ? shareSlug : 'Anon Provider')}
        description={
          <span className="inline-flex flex-col gap-1.5 text-muted-foreground">
            <HashLink hash={wallet} kind="account" visibleChars={22} withSns />
            <span className="text-[11px]">
              Public on-chain reputation card. Visible to anyone evaluating this provider before
              awarding an RFP.
            </span>
          </span>
        }
        size="md"
      />

      {/* Header callout — symmetric with buyer profile. */}
      <div className="rounded-xl border border-dashed border-primary/25 bg-primary/[0.03] px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Public profile.</strong> Reputation here counts only
        wins where this wallet participated as a public bidder, plus anonymous wins the provider has
        explicitly merged via <strong>Claim reputation</strong>. Anonymous activity is managed from{' '}
        <Link href="/dashboard/bidding" className="text-primary underline-offset-2 hover:underline">
          your dashboard
        </Link>
        . Claim merges reputation counters only — the underlying anonymous wins stay off this page
        and remain anonymous on chain.
      </div>

      <ShareCard
        shareHref={`/providers/${shareSlug}`}
        shareText={
          profile?.display_name
            ? `${profile.display_name} on @tendrdotbid - sealed-bid procurement on Solana. {url}`
            : 'Provider profile on @tendrdotbid - sealed-bid procurement on Solana. {url}'
        }
        ogImageUrl={`/api/og/provider/${wallet}`}
        downloadFilename={`${shareSlug.endsWith('.sol') ? shareSlug : wallet}-provider-tendr.bid.png`}
      >
        <ProfileOgCard
          kind="provider"
          display={shareSlug.endsWith('.sol') ? shareSlug : truncateForHero(wallet)}
          stats={
            providerRep
              ? [
                  { value: providerRep.totalWins.toString(), label: 'wins' },
                  { value: providerRep.completedProjects.toString(), label: 'completed' },
                  { value: fmtUsdShort(providerRep.totalEarnedUsdc), label: 'earned' },
                ]
              : [
                  { value: '0', label: 'wins' },
                  { value: '0', label: 'completed' },
                  { value: '$0', label: 'earned' },
                ]
          }
        />
      </ShareCard>

      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUpIcon className="size-4 text-muted-foreground" />
            Reputation
          </CardTitle>
          <Link
            href="/docs/reputation-model"
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground"
            title="What every reputation field means"
          >
            on-chain · how it works →
          </Link>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {count ?? 0}
            </span>{' '}
            public bidder-mode {count === 1 ? 'bid' : 'bids'} committed on tendr.bid. Private bids
            are signed by per-RFP ephemerals and are not visible from any main wallet.
          </p>
          {providerRep ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <RepStat
                label="Wins"
                value={String(providerRep.totalWins ?? 0)}
                hint={`$${microUsdcToDecimal(providerRep.totalWonUsdc)} won`}
              />
              <RepStat
                label="Completed"
                value={String(providerRep.completedProjects ?? 0)}
                hint={`$${microUsdcToDecimal(providerRep.totalEarnedUsdc)} earned`}
              />
              <RepStat
                label="Late"
                value={String(providerRep.lateMilestones ?? 0)}
                hint="delivery deadlines missed"
                tone={providerRep.lateMilestones > 0 ? 'warn' : 'normal'}
              />
              <RepStat
                label="Disputed"
                value={String(providerRep.disputedMilestones ?? 0)}
                hint="escalations"
                tone={providerRep.disputedMilestones > 0 ? 'warn' : 'normal'}
              />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
              No on-chain reputation account yet. The first award + first milestone delivery create
              it.
            </p>
          )}
        </CardContent>
      </Card>

      {awardedRows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-baseline justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <BriefcaseIcon className="size-4 text-muted-foreground" />
              Public awarded projects ({awardedRows.length})
            </CardTitle>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              public bidder mode only
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {/* Scope clarification — symmetric with the buyer profile's
                "Public RFPs by status" note. v2 select_bid writes
                `rfp.winner_provider = bid.provider` (the per-RFP eph) for
                private bidder mode, so the memcmp filter on this page
                only matches public-mode wins. attest_win merges the eph's
                ProviderReputation into the main wallet's PDA but never
                modifies `rfp.winner_provider` — claimed wins therefore
                appear in the Reputation card above but never on this list. */}
            <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
              Lists only RFPs won in public bidder mode. Anonymous wins claimed via{' '}
              <strong>Claim reputation</strong> contribute counters to the Reputation card above but
              stay off this list — the wins themselves remain anonymous on chain.
            </p>
            <AwardedProjectGroup label="In progress" rows={inProgressRows} />
            <AwardedProjectGroup label="Completed" rows={completedRows} />
            <AwardedProjectGroup label="Other" rows={otherRows} />
          </CardContent>
        </Card>
      )}

      <YourBidsList
        bids={ownBids}
        emptyTitle="No public bids on record"
        emptyBody="No public bidder-mode bids recorded for this wallet yet."
        notice={
          <>
            Public bidder-mode bids only — private-mode bids are signed by per-RFP ephemerals and
            stay anonymous on chain by design. Owners can manage their private bids (and Claim
            reputation on completed wins) from{' '}
            <Link
              href="/dashboard/bidding"
              className="text-primary underline-offset-2 hover:underline"
            >
              Dashboard
            </Link>
            .
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <DataField label="wallet" value={<HashLink hash={wallet} kind="account" withSns />} />
          <DataField label="program" value={<HashLink hash={TENDER_PROGRAM_ID} kind="account" />} />
        </CardContent>
      </Card>
    </main>
  );
}

function RepStat({
  label,
  value,
  hint,
  tone = 'normal',
}: { label: string; value: string; hint: string; tone?: 'normal' | 'warn' | 'bad' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/40 p-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'font-mono text-2xl font-semibold tabular-nums',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </div>
  );
}

interface AwardedProjectRow {
  pda: string;
  title: string | null;
  status: string;
  contractValueMicroUsdc: bigint;
  createdAt: number;
}

function AwardedProjectGroup({ label, rows }: { label: string; rows: AwardedProjectRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label} ({rows.length})
      </span>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.pda}>
            <Link
              href={`/rfps/${r.pda}`}
              className="flex flex-col gap-1 rounded-xl border border-border bg-card/40 p-3 transition-colors hover:border-primary/30 hover:bg-primary/5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-sm font-semibold">
                  {r.title ?? 'Untitled RFP'}
                </span>
                <StatusPill tone={awardedStatusTone(r.status)}>{r.status}</StatusPill>
              </div>
              <div className="flex flex-wrap items-baseline gap-3 font-mono text-[11px] text-muted-foreground">
                {/* linkable={false} — outer <Link> wraps the whole card,
                    nesting another <a> (default Solscan link) is invalid
                    HTML. Copy still works. */}
                <HashLink hash={r.pda} kind="account" visibleChars={6} linkable={false} />
                <span>·</span>
                <span>${microUsdcToDecimal(r.contractValueMicroUsdc)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function awardedStatusTone(status: string): StatusTone {
  if (status === 'completed') return 'awarded';
  if (status === 'inprogress' || status === 'funded') return 'awarded';
  if (status === 'awarded') return 'sealed';
  if (status === 'disputed') return 'sealed';
  return 'open';
}
