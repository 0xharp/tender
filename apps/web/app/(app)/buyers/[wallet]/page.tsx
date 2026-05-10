import type { Address } from '@solana/kit';
import { TrendingUpIcon } from 'lucide-react';
import Link from 'next/link';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { BuyerRfpsByStatus } from '@/components/profile/buyer-rfps-by-status';
import { ShareCard } from '@/components/profile/share-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProfileOgCard } from '@/lib/og/profile-card';
import { preferredProfileSlug, resolveWalletParam } from '@/lib/sns/resolve-server';
import {
  fetchBuyerReputation,
  listRfps,
  microUsdcToDecimal,
  rfpStatusToString,
  unixSecondsToIso,
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
  // See providers/[wallet]/page.tsx for the rationale on the OG/Twitter
  // overrides - same pattern, different copy.
  const { wallet: rawWallet } = await params;
  try {
    const pubkey = await resolveWalletParam(rawWallet);
    const slug = await preferredProfileSlug(pubkey);
    const handle = slug.endsWith('.sol') ? slug : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
    const title = `${handle} · buyer on tendr.bid`;
    const description = `Public on-chain reputation for ${handle} - sealed-bid procurement on Solana.`;
    return {
      title,
      description,
      alternates: { canonical: `/buyers/${pubkey}` },
      openGraph: { title, description, type: 'profile' as const },
      twitter: { title, description, card: 'summary_large_image' as const },
    };
  } catch {
    return {};
  }
}

export default async function Page({ params }: PageProps) {
  const { wallet: rawWallet } = await params;
  // Resolve `.sol → pubkey`. URL bar stays as-typed (.sol if .sol, pubkey
  // if pubkey). Page renders with the canonical pubkey internally.
  const wallet = await resolveWalletParam(rawWallet);
  const walletAddr = wallet as Address;
  // Profile pages are pure-public — own-profile == visitor view. Owner-
  // only surfaces (claim CTAs, sweep) live on /dashboard. Server-side
  // session lookup dropped on this surface.
  // Slug used in the share/copy URL — .sol when this wallet has a primary
  // domain, otherwise pubkey. Same readability win as the leaderboard links.
  const shareSlug = await preferredProfileSlug(wallet);

  // Pull on-chain rep + every RFP this buyer has CREATED (not just awarded).
  // listRfps with the buyer memcmp filter gives us the full set including
  // ones that never saw bids - which lets us show e.g. "ratio of awards to
  // creates" without needing a separate counter on chain.
  const supabase = await serverSupabase();
  const [buyerRep, allRfps, { data: titleRows }] = await Promise.all([
    fetchBuyerReputation(walletAddr),
    listRfps({ buyer: walletAddr }),
    supabase
      .from('rfps')
      .select('on_chain_pda, title, scope_summary')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const titleByPda = new Map((titleRows ?? []).map((r) => [r.on_chain_pda, r]));

  const totalCreated = allRfps.length;

  // Group RFPs by status for the "RFPs by status" card. Reads on-chain
  // status, so even pre-meta orphans (no supabase row) appear with their
  // PDA as a placeholder title - no silent drops.
  const rfpsByStatus = new Map<string, { pda: string; title: string; createdAtIso: string }[]>();
  for (const r of allRfps) {
    const status = rfpStatusToString(r.data.status);
    const meta = titleByPda.get(r.address);
    const entry = {
      pda: r.address,
      title: meta?.title ?? `RFP ${r.address.slice(0, 8)}…`,
      createdAtIso: unixSecondsToIso(r.data.createdAt),
    };
    if (!rfpsByStatus.has(status)) rfpsByStatus.set(status, []);
    rfpsByStatus.get(status)!.push(entry);
  }

  // Display a stable status order so the page doesn't reshuffle on refresh.
  const statusDisplayOrder = [
    'open',
    'reveal',
    'bidsclosed',
    'awarded',
    'funded',
    'inprogress',
    'completed',
    'disputed',
    'cancelled',
    'ghostedbybuyer',
  ];
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Public buyer profile"
        // Title: SNS-claimed wallet renders the .tendr.sol handle;
        // otherwise a generic "Anon Buyer" fallback. No eph detection —
        // the page treats every URL as a main wallet (legacy private-
        // buyer ephs surface as their raw pubkey, accepted as a quirk of
        // pre-v2 envelope data).
        title={shareSlug.endsWith('.sol') ? shareSlug : 'Anon Buyer'}
        description={
          <span className="inline-flex flex-col gap-1.5 text-muted-foreground">
            <HashLink hash={wallet} kind="account" visibleChars={22} withSns />
            <span className="text-[11px]">
              Public on-chain reputation card. Visible to anyone deciding whether to bid on this
              buyer's RFPs.
            </span>
          </span>
        }
        size="md"
      />

      {/* Header callout — explains what this surface is + how anon
          activity surfaces here. */}
      <div className="rounded-xl border border-dashed border-primary/25 bg-primary/[0.03] px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Public profile.</strong> Reputation here counts only
        RFPs where this wallet participated as a public buyer, plus anonymous RFPs the buyer has
        explicitly merged via <strong>Claim reputation</strong>. Anonymous activity is managed from{' '}
        <Link href="/dashboard/buying" className="text-primary underline-offset-2 hover:underline">
          your dashboard
        </Link>
        . Claim merges reputation counters only — the underlying anonymous RFPs stay off this page
        and remain anonymous on chain.
      </div>

      <ShareCard
        shareHref={`/buyers/${shareSlug}`}
        shareText="My buyer profile on @tendrdotbid - sealed-bid procurement on Solana. {url}"
        ogImageUrl={`/api/og/buyer/${wallet}`}
        downloadFilename={`${shareSlug.endsWith('.sol') ? shareSlug : wallet}-buyer-tendr.bid.png`}
      >
        <ProfileOgCard
          kind="buyer"
          display={shareSlug.endsWith('.sol') ? shareSlug : truncateForHero(wallet)}
          stats={
            buyerRep
              ? [
                  { value: buyerRep.totalRfps.toString(), label: 'rfps' },
                  { value: buyerRep.fundedRfps.toString(), label: 'funded' },
                  { value: fmtUsdShort(buyerRep.totalReleasedUsdc), label: 'released' },
                ]
              : [
                  { value: '0', label: 'rfps' },
                  { value: '0', label: 'funded' },
                  { value: '$0', label: 'released' },
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
              {totalCreated}
            </span>{' '}
            {totalCreated === 1 ? 'RFP' : 'RFPs'} created on tendr.bid.
          </p>
          {buyerRep ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <RepStat
                label="Awarded"
                value={String(buyerRep.totalRfps ?? 0)}
                hint={`$${microUsdcToDecimal(buyerRep.totalLockedUsdc)} contracted`}
              />
              <RepStat
                label="Funded"
                value={String(buyerRep.fundedRfps ?? 0)}
                hint="escrow locked on-chain"
              />
              <RepStat
                label="Completed"
                value={String(buyerRep.completedRfps ?? 0)}
                hint={`$${microUsdcToDecimal(buyerRep.totalReleasedUsdc)} released`}
              />
              <RepStat
                label="Cancelled"
                value={String(buyerRep.cancelledMilestones ?? 0)}
                hint="mid-flight cancellations"
                tone={buyerRep.cancelledMilestones > 0 ? 'warn' : 'normal'}
              />
              <RepStat
                label="Disputed"
                value={String(buyerRep.disputedMilestones ?? 0)}
                hint="escalations"
                tone={buyerRep.disputedMilestones > 0 ? 'warn' : 'normal'}
              />
              <RepStat
                label="Ghosted"
                value={String(buyerRep.ghostedRfps ?? 0)}
                hint="awarded but never funded"
                tone={buyerRep.ghostedRfps > 0 ? 'bad' : 'normal'}
              />
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
              No on-chain reputation account yet. The first awarded RFP creates it.
            </p>
          )}
          {buyerRep && totalCreated > 0 && buyerRep.totalRfps > 0 && (
            <div className="rounded-lg border border-dashed border-border/60 bg-card/30 p-3 text-[11px] text-muted-foreground">
              Follow-through:{' '}
              <span className="font-mono text-foreground tabular-nums">
                {Math.round((buyerRep.fundedRfps / buyerRep.totalRfps) * 100)}%
              </span>{' '}
              of awards funded ({buyerRep.fundedRfps}/{buyerRep.totalRfps}).{' '}
              {buyerRep.fundedRfps > 0 && (
                <>
                  Completion:{' '}
                  <span className="font-mono text-foreground tabular-nums">
                    {Math.round((buyerRep.completedRfps / buyerRep.fundedRfps) * 100)}%
                  </span>{' '}
                  of funded projects ran to completion.
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <BuyerRfpsByStatus
        walletAddress={wallet}
        statusOrder={statusDisplayOrder}
        serverEntriesByStatus={Object.fromEntries(rfpsByStatus.entries())}
      />

      {/* v2: EphemeralBalancePanel moved to /me/projects (single canonical
          home for sweeps, role-agnostic). Wallet popover links there too. */}

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
