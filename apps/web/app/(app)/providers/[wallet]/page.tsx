import type { Address } from '@solana/kit';
import { BriefcaseIcon, TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { ProfileShareButton } from '@/components/profile/profile-share-button';
import { YourBidsList } from '@/components/rfp/your-bids-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { preferredProfileSlug, resolveWalletParam } from '@/lib/sns/resolve-server';
import {
  fetchProviderReputation,
  listBids,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

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
  const sessionWallet = await getCurrentWallet();
  const isOwnProfile = sessionWallet === wallet;

  // Profile is off-chain. Bid count comes from on-chain (public-mode only).
  // Private-mode bids are signed by per-RFP ephemeral wallets and stay
  // unlinkable to the main wallet — losing private bids therefore don't
  // surface here ever, on purpose.
  //
  // Awarded RFPs DO surface (default mode AND private-bidder mode) via
  // listRfps with memcmp on rfp.winner_provider. The Ed25519SigVerify
  // binding-sig at select_bid time means winner_provider is the verified
  // main wallet for both modes — so this card shows the provider's full
  // track record of won + completed projects, even ones whose original
  // bid was private.
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
        title={profile?.display_name ?? 'Pseudonymous provider'}
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
        actions={
          <ProfileShareButton
            href={`/providers/${shareSlug}`}
            shareText={
              profile?.display_name
                ? `${profile.display_name} on @tendrdotbid - sealed-bid procurement on Solana. {url}`
                : 'Provider profile on @tendrdotbid - sealed-bid procurement on Solana. {url}'
            }
          />
        }
      />

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
            public {count === 1 ? 'sealed bid' : 'sealed bids'} committed on tendr.bid.
          </p>
          {providerRep ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <RepStat
                label="Wins"
                value={String(providerRep.totalWins ?? 0)}
                hint={`$${microUsdcToDecimal(providerRep.totalWonUsdc)} awarded`}
              />
              <RepStat
                label="Completed"
                value={String(providerRep.completedProjects ?? 0)}
                hint={`$${microUsdcToDecimal(providerRep.totalEarnedUsdc)} earned (net of fee)`}
              />
              <RepStat
                label="Disputed"
                value={String(providerRep.disputedMilestones ?? 0)}
                hint={`$${microUsdcToDecimal(providerRep.totalDisputedUsdc)} in dispute path`}
                tone="warn"
              />
              <RepStat
                label="Late"
                value={String(providerRep.lateMilestones ?? 0)}
                hint="missed delivery deadline"
                tone="warn"
              />
              <RepStat
                label="Abandoned"
                value={String(providerRep.abandonedProjects ?? 0)}
                hint="walked from project"
                tone="warn"
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
              Awarded projects ({awardedRows.length})
            </CardTitle>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              public + private (post-award)
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
              Every RFP this main wallet has won. Private-mode wins surface here too — the Ed25519
              binding signature at award time records the verified main wallet on chain, so
              reputation + project history apply uniformly across both privacy modes.
            </p>
            <AwardedProjectGroup label="In progress" rows={inProgressRows} />
            <AwardedProjectGroup label="Completed" rows={completedRows} />
            <AwardedProjectGroup label="Other" rows={otherRows} />
          </CardContent>
        </Card>
      )}

      <YourBidsList
        bids={ownBids}
        emptyTitle={isOwnProfile ? 'No public bids yet' : 'No public bids on record'}
        emptyBody={
          isOwnProfile
            ? 'Browse the marketplace and submit a sealed bid to see it here.'
            : "This provider hasn't submitted any public-mode bids visible from on-chain yet."
        }
        notice={
          <>
            Showing public-mode bids only. <strong>Losing</strong> private-mode bids stay anonymous
            by design — each is signed by a per-RFP ephemeral wallet that isn't linkable to this
            main wallet from the chain. Private-mode <strong>wins</strong> surface in "Awarded
            projects" above.{' '}
            {isOwnProfile
              ? 'Open the relevant RFP page and click "Check on-chain" to manage in-flight private bids.'
              : null}
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
}: { label: string; value: string; hint: string; tone?: 'normal' | 'warn' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-border/60 bg-card/40 p-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={
          tone === 'warn'
            ? 'font-mono text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400'
            : 'font-mono text-2xl font-semibold tabular-nums'
        }
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
