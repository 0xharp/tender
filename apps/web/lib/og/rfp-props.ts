/**
 * Shared composer for `RfpOgCardProps`. Used by both:
 *  - `app/(app)/rfps/[id]/opengraph-image.tsx` — the PNG sent to social
 *    crawlers via the file-convention OG route
 *  - `app/(app)/rfps/[id]/page.tsx` — the in-page Share preview that
 *    shows users what their link will unfurl as
 *
 * Centralizing the prop derivation keeps those two surfaces from
 * silently drifting (e.g. preview saying "$0 value" while the actual
 * unfurl shows "$50k") as the underlying chain fields evolve.
 */
import type { RfpOgCardProps, RfpOgPrivacyMode, RfpOgStatus } from './rfp-card';

export interface BuildRfpOgPropsInput {
  /** Human-readable title from supabase. */
  title: string;
  /** `<handle>.tendr.sol` when claimed; raw pubkey otherwise. */
  buyerSlug: string;
  buyerWallet: string;
  contractValueMicroUsdc: bigint;
  milestoneCount: number;
  bidCount: number;
  /** ISO timestamp of the bid-window close (chainRfp.bidCloseAt). */
  bidCloseAtIso: string;
  /** Raw on-chain status string (`rfpStatusToString(chainRfp.status)`). */
  onChainStatus: string;
  privacyMode: RfpOgPrivacyMode;
  /**
   * v2: when 'private', the buyerHandle renders as "Anonymous 🔒"
   * regardless of slug/wallet. The on-chain rfp.buyer is an HD-derived
   * ephemeral; surfacing it here would encourage observers to cluster
   * an unrelated chunk of the buyer's keychain. Default 'public'.
   */
  buyerVisibility?: 'public' | 'private';
}

export const fmtUsdShort = (microUsdc: bigint): string => {
  const usdc = Number(microUsdc) / 1_000_000;
  if (usdc >= 1_000_000) return `$${(usdc / 1_000_000).toFixed(1)}M`;
  if (usdc >= 1_000) return `$${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 1) return `$${usdc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return '$0';
};

export const truncateWallet = (wallet: string, head = 4, tail = 4): string =>
  wallet.length <= head + tail + 1 ? wallet : `${wallet.slice(0, head)}…${wallet.slice(-tail)}`;

/**
 * Smooth on-chain status into the OG card's tone enum. Treats "open
 * but bid-window expired" as "sealed" so the OG label and the in-app
 * banner agree even before the buyer calls `rfp_close_bidding`.
 */
export function mapRfpOgStatus(onChain: string, bidCloseAtIso: string): RfpOgStatus {
  const bidsClosed = new Date(bidCloseAtIso).getTime() <= Date.now();
  if (onChain === 'open') return bidsClosed ? 'sealed' : 'open';
  if (onChain === 'bidsclosed') return 'sealed';
  if (onChain === 'reveal') return 'reveal';
  if (onChain === 'awarded') return 'awarded';
  if (onChain === 'completed') return 'completed';
  return 'closed';
}

/** Format bid close as a fourth bottom-rail stat. Past tense if the
 *  date has already elapsed — keeps the card honest after deadlines. */
function fmtBidsEndStat(bidCloseAtIso: string): { value: string; label: string } {
  const date = new Date(bidCloseAtIso);
  // `MMM D` (e.g. "May 15"). Year omitted: an OG card more than a year
  // old is rarely re-shared and the year would just steal label width.
  const value = date.toLocaleString('en-US', { month: 'short', day: 'numeric' });
  const ended = date.getTime() <= Date.now();
  return { value, label: ended ? 'bids ended' : 'bids end' };
}

export function buildRfpOgProps(input: BuildRfpOgPropsInput): RfpOgCardProps {
  const isPrivateBuyer = input.buyerVisibility === 'private';
  return {
    title: input.title,
    buyerHandle: isPrivateBuyer
      ? 'anonymous 🔒'
      : input.buyerSlug.endsWith('.sol')
        ? input.buyerSlug
        : truncateWallet(input.buyerWallet),
    privacyMode: input.privacyMode,
    buyerVisibility: input.buyerVisibility,
    status: mapRfpOgStatus(input.onChainStatus, input.bidCloseAtIso),
    stats: [
      { value: fmtUsdShort(input.contractValueMicroUsdc), label: 'value' },
      { value: input.milestoneCount.toString(), label: 'milestones' },
      { value: input.bidCount.toString(), label: 'bids' },
      fmtBidsEndStat(input.bidCloseAtIso),
    ],
  };
}
