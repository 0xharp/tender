import type { Address } from '@solana/kit';
import { ImageResponse } from 'next/og';

import { RfpOgCard, type RfpOgCardProps } from '@/lib/og/rfp-card';
import { buildRfpOgProps } from '@/lib/og/rfp-props';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import { bidderVisibilityToString, fetchRfp, rfpStatusToString } from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';

export const alt = 'RFP on tendr.bid';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Defaults so we always return an image even when supabase, the RPC,
  // or SNS hiccups - a 307 from the OG route would mean X / Slack /
  // Discord see no card on a freshly-shared RFP link.
  let props: RfpOgCardProps = {
    title: 'Sealed-bid RFP',
    buyerHandle: '—',
    privacyMode: 'public',
    status: 'open',
    stats: [
      { value: '$0', label: 'value' },
      { value: '0', label: 'milestones' },
      { value: '0', label: 'bids' },
      { value: '—', label: 'bids end' },
    ],
  };

  try {
    const supabase = await serverSupabase();
    const [chainRfp, metaResult] = await Promise.all([
      fetchRfp(id as Address),
      supabase.from('rfps').select('title').eq('on_chain_pda', id).maybeSingle(),
    ]);

    if (chainRfp) {
      const buyerSlug = await preferredProfileSlug(chainRfp.buyer);
      props = buildRfpOgProps({
        title: metaResult.data?.title ?? 'Sealed-bid RFP',
        buyerSlug,
        buyerWallet: chainRfp.buyer,
        contractValueMicroUsdc: chainRfp.contractValue,
        milestoneCount: chainRfp.milestoneCount,
        bidCount: chainRfp.bidCount,
        bidCloseAtIso: new Date(Number(chainRfp.bidCloseAt) * 1000).toISOString(),
        onChainStatus: rfpStatusToString(chainRfp.status),
        privacyMode: bidderVisibilityToString(chainRfp.bidderVisibility),
      });
    }
  } catch {
    // swallow - render the default empty-state card.
  }

  return new ImageResponse(<RfpOgCard {...props} />, size);
}
