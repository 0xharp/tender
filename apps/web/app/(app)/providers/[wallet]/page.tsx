import type { Address } from '@solana/kit';
import { TrendingUpIcon } from 'lucide-react';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { ProfileShareButton } from '@/components/profile/profile-share-button';
import { YourBidsList } from '@/components/rfp/your-bids-list';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import { fetchProviderReputation, listBids, microUsdcToDecimal } from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { TENDER_PROGRAM_ID } from '@tender/shared';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ wallet: string }>;
}

export default async function Page({ params }: PageProps) {
  const { wallet } = await params;
  const supabase = await serverSupabase();
  const walletAddr = wallet as Address;
  const sessionWallet = await getCurrentWallet();
  const isOwnProfile = sessionWallet === wallet;

  // Profile is off-chain. Bid count comes from on-chain (public-mode only).
  // Private-mode bids are signed by per-RFP ephemeral wallets and stay
  // unlinkable to the main wallet - they don't surface here ever, on purpose.
  const [{ data: profile }, ownBids, providerRep] = await Promise.all([
    supabase.from('providers').select('*').eq('wallet', wallet).maybeSingle(),
    listBids({ providerWallet: walletAddr }),
    fetchProviderReputation(walletAddr),
  ]);
  const count = ownBids.length;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Provider"
        title={profile?.display_name ?? 'Pseudonymous provider'}
        description={
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <HashLink hash={wallet} kind="account" visibleChars={22} />
          </span>
        }
        size="md"
        actions={
          <ProfileShareButton
            href={`/providers/${wallet}`}
            shareText={
              profile?.display_name
                ? `${profile.display_name} on tendr.bid - sealed-bid procurement on Solana. {url}`
                : 'Provider profile on tendr.bid - sealed-bid procurement on Solana. {url}'
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
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            on-chain · updated per award + milestone
          </span>
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
            Showing public-mode bids only. Private-mode bids stay anonymous by design - each is
            signed by a per-RFP ephemeral wallet that isn't linkable to this main wallet from the
            chain.{' '}
            {isOwnProfile
              ? 'Open the relevant RFP page and click "Check on-chain" to manage your private bids.'
              : null}
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">On-chain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2.5">
          <DataField label="wallet" value={<HashLink hash={wallet} kind="account" />} />
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
