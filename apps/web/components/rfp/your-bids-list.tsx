
import { type BidCommitWithAddress, unixSecondsToIso } from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';

import { YourBidsListClient, type YourBidRow } from './your-bids-list-client';

export interface YourBidsListProps {
  /** Bid records from `listBids({ providerWallet })` - public-mode bids only. */
  bids: BidCommitWithAddress[];
  /** Empty-state copy. Differs slightly between dashboard ("you haven't bid…")
   *  and a public-profile view of someone else. */
  emptyTitle?: string;
  emptyBody?: string;
  /** Optional preface line above the list (e.g. private-bids reminder). */
  notice?: React.ReactNode;
}

/**
 * Server component that fetches RFP titles + serializes bid records into a
 * shape the client component can sort/filter without re-querying chain.
 *
 * Public-mode bids only by construction: these are bids signed by the wallet's
 * main key. Private-mode bids are signed by per-RFP ephemeral wallets and are
 * not enumerable from the main wallet (that's the privacy property).
 */
export async function YourBidsList({
  bids,
  emptyTitle = 'No public bids yet',
  emptyBody = 'Browse the marketplace and submit a sealed bid to see it here.',
  notice,
}: YourBidsListProps) {
  const rfpPdas = Array.from(new Set(bids.map((b) => String(b.data.rfp))));

  const supabase = await serverSupabase();
  const titlesByPda = new Map<string, string>();
  if (rfpPdas.length > 0) {
    const { data } = await supabase
      .from('rfps')
      .select('on_chain_pda, title')
      .in('on_chain_pda', rfpPdas);
    for (const r of data ?? []) {
      titlesByPda.set(r.on_chain_pda, r.title);
    }
  }

  const rows: YourBidRow[] = bids.map((b) => {
    const rfpPda = String(b.data.rfp);
    return {
      bidPda: String(b.address),
      rfpPda,
      rfpTitle: titlesByPda.get(rfpPda) ?? null,
      submittedAtIso: unixSecondsToIso(b.data.submittedAt),
    };
  });

  return (
    <YourBidsListClient
      rows={rows}
      emptyTitle={emptyTitle}
      emptyBody={emptyBody}
      notice={notice}
    />
  );
}
