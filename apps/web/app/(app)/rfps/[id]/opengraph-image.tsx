import { ImageResponse } from 'next/og';
import type { Address } from '@solana/kit';

import { RfpOgCard, type RfpOgPrivacyMode, type RfpOgStatus } from '@/lib/og/rfp-card';
import { preferredProfileSlug } from '@/lib/sns/resolve-server';
import {
  bidderVisibilityToString,
  fetchRfp,
  rfpStatusToString,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';

export const alt = 'RFP on tendr.bid';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const fmtUsd = (microUsdc: bigint): string => {
  const usdc = Number(microUsdc) / 1_000_000;
  if (usdc >= 1_000_000) return `$${(usdc / 1_000_000).toFixed(1)}M`;
  if (usdc >= 1_000) return `$${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 1) return `$${usdc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return '$0';
};

const truncate = (wallet: string, head = 4, tail = 4): string =>
  wallet.length <= head + tail + 1 ? wallet : `${wallet.slice(0, head)}…${wallet.slice(-tail)}`;

// Map the on-chain status string to the OG card's smaller tone enum.
// Bids-window-closed-but-not-yet-formally-closed surfaces as "sealed" -
// matches the in-app `displayStatus` smoothing, so the OG label and the
// page banner agree on what state the RFP is in.
function mapStatus(onChain: string, bidCloseAtIso: string | null): RfpOgStatus {
  const bidsClosed =
    bidCloseAtIso !== null && new Date(bidCloseAtIso).getTime() <= Date.now();
  if (onChain === 'open') return bidsClosed ? 'sealed' : 'open';
  if (onChain === 'bidsclosed') return 'sealed';
  if (onChain === 'reveal') return 'reveal';
  if (onChain === 'awarded') return 'awarded';
  if (onChain === 'completed') return 'completed';
  return 'closed';
}

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Defaults so we always return an image even when supabase, the RPC,
  // or SNS hiccups - a 307 from the OG route would mean X / Slack /
  // Discord see no card on a freshly-shared RFP link.
  let title = 'Sealed-bid RFP';
  let buyerHandle = '—';
  let privacyMode: RfpOgPrivacyMode = 'public';
  let status: RfpOgStatus = 'open';
  let stats = [
    { value: '$0', label: 'value' },
    { value: '0', label: 'milestones' },
    { value: '0', label: 'bids' },
  ];

  try {
    const supabase = await serverSupabase();
    const [chainRfp, metaResult] = await Promise.all([
      fetchRfp(id as Address),
      supabase
        .from('rfps')
        .select('title')
        .eq('on_chain_pda', id)
        .maybeSingle(),
    ]);

    if (chainRfp) {
      const onChainStatus = rfpStatusToString(chainRfp.status);
      const bidCloseAtIso = new Date(Number(chainRfp.bidCloseAt) * 1000).toISOString();
      status = mapStatus(onChainStatus, bidCloseAtIso);
      // bidderVisibilityToString returns the same `'public' | 'buyer_only'`
      // enum that `PrivacyTag` and `RfpOgCard` consume - direct passthrough.
      privacyMode = bidderVisibilityToString(chainRfp.bidderVisibility);

      const slug = await preferredProfileSlug(chainRfp.buyer);
      buyerHandle = slug.endsWith('.sol') ? slug : truncate(chainRfp.buyer);

      stats = [
        { value: fmtUsd(chainRfp.contractValue), label: 'value' },
        { value: chainRfp.milestoneCount.toString(), label: 'milestones' },
        { value: chainRfp.bidCount.toString(), label: 'bids' },
      ];
    }

    if (metaResult.data?.title) {
      title = metaResult.data.title;
    }
  } catch {
    // swallow - render the default empty-state card.
  }

  return new ImageResponse(
    <RfpOgCard
      title={title}
      buyerHandle={buyerHandle}
      privacyMode={privacyMode}
      status={status}
      stats={stats}
    />,
    size,
  );
}
