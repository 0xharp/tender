import type { Address } from '@solana/kit';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { LocalTime } from '@/components/local-time';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill } from '@/components/primitives/status-pill';
import { BidComposer } from '@/components/rfp/bid-composer';
import { PrivateBidComposeGate } from '@/components/rfp/private-bid-compose-gate';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import {
  bidderVisibilityToString,
  bytesToHex,
  fetchRfp,
  listBids,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Pure new-bid composer. Existing-bid management lives on the RFP detail
 * page (`/rfps/[id]`) via `YourBidPanel` - that's the canonical surface.
 *
 * Routing:
 *   - Buyer / closed RFP → "bid not available" message.
 *   - Public mode + existing bid → redirect to /rfps/[id] (server-side).
 *   - Private mode → render PrivateBidComposeGate (client checks localStorage
 *     cache; redirects if a bid exists, otherwise renders the composer).
 *   - Public mode + no bid → render BidComposer.
 */
export default async function Page({ params }: PageProps) {
  const { id } = await params;
  const wallet = await getCurrentWallet();
  const supabase = await serverSupabase();

  const [chainRfp, metaResult] = await Promise.all([
    fetchRfp(id as Address),
    supabase
      .from('rfps')
      .select('id, on_chain_pda, rfp_nonce_hex, title')
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
  const buyerEncryptionPubkeyHex = bytesToHex(chainRfp.buyerEncryptionPubkey);
  const rfpNonceHex = meta.rfp_nonce_hex;
  const hasReserve = !chainRfp.reservePriceCommitment.every((b: number) => b === 0);
  const feeBps = chainRfp.feeBps;

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
              : 'This RFP is no longer accepting bids - status is not Open or the bid window has closed.'
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

  // Public mode + existing bid → redirect to RFP page (canonical management).
  if (wallet && visibility === 'public') {
    const matches = await listBids({ rfpPda: id as Address, providerWallet: wallet as Address });
    if (matches.length > 0) {
      redirect(`/rfps/${id}`);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="Provider · submit bid"
        title={meta.title}
        size="sm"
        description={
          <>
            Bidding closes <LocalTime iso={bidCloseAtIso} />.
          </>
        }
        actions={<StatusPill tone="sealed">sealed</StatusPill>}
      />

      {visibility === 'buyer_only' ? (
        <PrivateBidComposeGate
          rfpId={meta.id}
          rfpPda={meta.on_chain_pda}
          rfpNonceHex={rfpNonceHex}
          buyerEncryptionPubkeyHex={buyerEncryptionPubkeyHex}
          hasReserve={hasReserve}
          feeBps={feeBps}
        />
      ) : (
        <BidComposer
          rfpId={meta.id}
          rfpPda={meta.on_chain_pda}
          rfpNonceHex={rfpNonceHex}
          bidderVisibility={visibility}
          buyerEncryptionPubkeyHex={buyerEncryptionPubkeyHex}
          hasReserve={hasReserve}
          feeBps={feeBps}
        />
      )}
    </main>
  );
}
