import { ImageResponse } from 'next/og';
import type { Address } from '@solana/kit';

import { ProfileOgCard } from '@/lib/og/profile-card';
import { preferredProfileSlug, tryResolveWalletParam } from '@/lib/sns/resolve-server';
import { fetchProviderReputation } from '@/lib/solana/chain-reads';

// File-convention metadata picked up by Next at build time. The PNG is
// dynamically generated per `[wallet]` param so first-touch generation +
// per-wallet caching is automatic.
export const alt = 'Provider profile on tendr.bid';
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

  // Defensive: any failure (bad SNS, network blip, decode error) falls
  // through with sane defaults so we always return an image. A 307 from
  // the OG route would mean X / Slack / Discord see no card at all.
  let display = 'Pseudonymous provider';
  let walletShort = '—';
  let stats = [
    { value: '0', label: 'wins' },
    { value: '0', label: 'completed' },
    { value: '$0', label: 'earned' },
  ];

  try {
    const wallet = await tryResolveWalletParam(rawWallet);
    if (wallet) {
      walletShort = truncate(wallet);
      const slug = await preferredProfileSlug(wallet);
      // `preferredProfileSlug` returns either the .sol or the raw pubkey -
      // surface the .sol prominently if we got one, otherwise the
      // truncated hash (the full one is in walletShort below).
      display = slug.endsWith('.sol') ? slug : truncate(wallet, 4, 4);

      const rep = await fetchProviderReputation(wallet as Address);
      if (rep) {
        stats = [
          { value: rep.totalWins.toString(), label: 'wins' },
          { value: rep.completedProjects.toString(), label: 'completed' },
          { value: fmtUsd(rep.totalEarnedUsdc), label: 'earned' },
        ];
      }
    }
  } catch {
    // swallow - render the default empty-state card.
  }

  return new ImageResponse(
    <ProfileOgCard role="provider" display={display} walletShort={walletShort} stats={stats} />,
    size,
  );
}
