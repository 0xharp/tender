import { ImageResponse } from 'next/og';
import type { Address } from '@solana/kit';

import { ProfileOgCard } from '@/lib/og/profile-card';
import { preferredProfileSlug, tryResolveWalletParam } from '@/lib/sns/resolve-server';
import { fetchBuyerReputation } from '@/lib/solana/chain-reads';

export const alt = 'Buyer profile on tendr.bid';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const fmtUsd = (microUsdc: bigint): string => {
  const usdc = Number(microUsdc) / 1_000_000;
  if (usdc >= 1_000_000) return `$${(usdc / 1_000_000).toFixed(1)}M`;
  if (usdc >= 1_000) return `$${(usdc / 1_000).toFixed(1)}k`;
  if (usdc >= 1) return `$${usdc.toFixed(0)}`;
  return '$0';
};

const truncate = (wallet: string, head = 8, tail = 8): string =>
  wallet.length <= head + tail + 1 ? wallet : `${wallet.slice(0, head)}…${wallet.slice(-tail)}`;

export default async function Image({
  params,
}: {
  params: Promise<{ wallet: string }>;
}) {
  const { wallet: rawWallet } = await params;

  let display = 'Pseudonymous buyer';
  let walletShort = '—';
  let stats = [
    { value: '0', label: 'rfps' },
    { value: '0', label: 'funded' },
    { value: '$0', label: 'released' },
  ];

  try {
    const wallet = await tryResolveWalletParam(rawWallet);
    if (wallet) {
      walletShort = truncate(wallet);
      const slug = await preferredProfileSlug(wallet);
      display = slug.endsWith('.sol') ? slug : truncate(wallet, 4, 4);

      const rep = await fetchBuyerReputation(wallet as Address);
      if (rep) {
        stats = [
          { value: rep.totalRfps.toString(), label: 'rfps' },
          { value: rep.fundedRfps.toString(), label: 'funded' },
          { value: fmtUsd(rep.totalReleasedUsdc), label: 'released' },
        ];
      }
    }
  } catch {
    // swallow - render the default empty-state card.
  }

  return new ImageResponse(
    <ProfileOgCard role="buyer" display={display} walletShort={walletShort} stats={stats} />,
    size,
  );
}
