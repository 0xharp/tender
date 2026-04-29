import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { BidComposer } from '@/components/rfp/bid-composer';
import { ExistingBidGate } from '@/components/rfp/existing-bid-gate';
import { Toaster } from '@/components/ui/sonner';
import { getCurrentWallet } from '@/lib/auth/session';
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
        <div className="rounded border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
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
      <main className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Bid not available</h1>
        </header>
        <div className="rounded border border-dashed border-border p-6 text-sm text-muted-foreground">
          {isBuyer
            ? 'You posted this RFP, so you cannot bid on it.'
            : 'This RFP is no longer accepting bids (status is not Open or the bid window has closed).'}
          <div className="mt-3">
            <Link href={`/rfps/${id}`} className="font-medium text-foreground underline">
              ← back to RFP
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Look up an existing bid by this signed-in provider (if any).
  // BidCommit PDA seeds = ["bid", rfp_pda, provider_wallet] — so each (rfp,
  // provider) pair has at most one bid on-chain. If the row exists, we
  // route to the manage-bid view instead of the composer.
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
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6 flex flex-col gap-2">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          {existingBid ? 'provider / your bid' : 'provider / submit bid'}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{rfp.title}</h1>
        <p className="text-xs text-muted-foreground">
          Bidding closes <LocalTime iso={rfp.bid_close_at} />.
        </p>
      </header>

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

      <Toaster />
    </main>
  );
}
