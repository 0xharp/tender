import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex as bytesToHexNoble } from '@noble/hashes/utils.js';
import { type Address } from '@solana/kit';
import bs58 from 'bs58';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill } from '@/components/primitives/status-pill';
import { BidComposer } from '@/components/rfp/bid-composer';
import { ExistingBidGate } from '@/components/rfp/existing-bid-gate';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import {
  bidderVisibilityToString,
  bytesToHex,
  fetchRfp,
  listBids,
  microUsdcToDecimal,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const wallet = await getCurrentWallet();
  const supabase = await serverSupabase();

  // Authoritative state from chain; title/scope/milestones + rfp_nonce_hex
  // (needed by L1 providers to derive bid_pda_seed) from supabase.
  const [chainRfp, metaResult] = await Promise.all([
    fetchRfp(id as Address),
    supabase
      .from('rfps')
      .select('id, on_chain_pda, rfp_nonce_hex, title, milestone_template')
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
  const bidCloseAtIso = unixSecondsToIso(chainRfp.bidCloseAt);
  const budgetUsdc = microUsdcToDecimal(chainRfp.budgetMax);
  const buyerEncryptionPubkeyHex = bytesToHex(chainRfp.buyerEncryptionPubkey);
  const rfpNonceHex = meta.rfp_nonce_hex;

  const isBuyer = wallet === buyerWallet;
  const isOpen = status === 'open' && new Date(bidCloseAtIso).getTime() > Date.now();

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

  // Has the viewer already bid here? Look on-chain (handles both L0 and L1).
  let existingBid: {
    on_chain_pda: string;
    commit_hash_hex: string;
    submitted_at: string;
  } | null = null;
  if (wallet) {
    const walletAddr = wallet as Address;
    const walletHash = sha256(bs58.decode(wallet));
    const [l0, l1] = await Promise.all([
      listBids({ rfpPda: id as Address, providerWallet: walletAddr }),
      listBids({ rfpPda: id as Address, providerWalletHash: walletHash }),
    ]);
    const found = l0[0] ?? l1[0];
    if (found) {
      existingBid = {
        on_chain_pda: found.address,
        commit_hash_hex: bytesToHexNoble(new Uint8Array(found.data.commitHash)),
        submitted_at: unixSecondsToIso(found.data.submittedAt),
      };
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow={existingBid ? 'Provider · your bid' : 'Provider · submit bid'}
        title={meta.title}
        size="sm"
        description={
          <>
            Bidding closes <LocalTime iso={bidCloseAtIso} />.
          </>
        }
        actions={<StatusPill tone="sealed">sealed</StatusPill>}
      />

      {existingBid && wallet ? (
        <ExistingBidGate
          rfpPda={meta.on_chain_pda}
          bidPda={existingBid.on_chain_pda}
          commitHashHex={existingBid.commit_hash_hex}
          submittedAt={existingBid.submitted_at}
          expectedProviderWallet={wallet}
        />
      ) : (
        <BidComposer
          rfpId={meta.id}
          rfpPda={meta.on_chain_pda}
          rfpNonceHex={rfpNonceHex}
          bidderVisibility={visibility}
          buyerEncryptionPubkeyHex={buyerEncryptionPubkeyHex}
          budgetMaxUsdc={budgetUsdc}
          milestoneCount={meta.milestone_template.length}
        />
      )}
    </main>
  );
}
