import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill } from '@/components/primitives/status-pill';
import { BidComposer } from '@/components/rfp/bid-composer';
import { ExistingBidGate } from '@/components/rfp/existing-bid-gate';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const [wallet, supabase] = await Promise.all([getCurrentWallet(), serverSupabase()]);

  const { data: rfp, error } = await supabase
    .from('rfps')
    .select(
      'id, on_chain_pda, buyer_wallet, buyer_encryption_pubkey_hex, title, status, bid_close_at, budget_max_usdc, milestone_template',
    )
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
  const isOpen = rfp.status === 'open' && new Date(rfp.bid_close_at).getTime() > Date.now();

  if (isBuyer || !isOpen) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
        <SectionHeader
          eyebrow="Provider · bid"
          title="Bid not available"
          size="sm"
          description={
            isBuyer
              ? 'You posted this RFP, so you cannot bid on it.'
              : 'This RFP is no longer accepting bids — status is not Open or the bid window has closed.'
          }
        />
        <Link
          href={`/rfps/${id}`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'w-fit gap-2 rounded-full px-4',
          )}
        >
          ← Back to RFP
        </Link>
      </main>
    );
  }

  let existingBid: {
    on_chain_pda: string;
    commit_hash_hex: string;
    submitted_at: string;
  } | null = null;
  if (wallet) {
    const { data } = await supabase
      .from('bid_ciphertexts')
      .select('on_chain_pda, commit_hash_hex, submitted_at')
      .eq('rfp_id', rfp.id)
      .eq('provider_wallet', wallet)
      .maybeSingle();
    if (data) existingBid = data;
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow={existingBid ? 'Provider · your bid' : 'Provider · submit bid'}
        title={rfp.title}
        size="sm"
        description={
          <>
            Bidding closes <LocalTime iso={rfp.bid_close_at} />.
          </>
        }
        actions={<StatusPill tone="sealed">sealed</StatusPill>}
      />

      {existingBid && wallet ? (
        <ExistingBidGate
          rfpPda={rfp.on_chain_pda}
          bidPda={existingBid.on_chain_pda}
          commitHashHex={existingBid.commit_hash_hex}
          submittedAt={existingBid.submitted_at}
          expectedProviderWallet={wallet}
        />
      ) : (
        <BidComposer
          rfpId={rfp.id}
          rfpPda={rfp.on_chain_pda}
          buyerEncryptionPubkeyHex={rfp.buyer_encryption_pubkey_hex}
          budgetMaxUsdc={rfp.budget_max_usdc}
          milestoneCount={rfp.milestone_template.length}
        />
      )}
    </main>
  );
}
