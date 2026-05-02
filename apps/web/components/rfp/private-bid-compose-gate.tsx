'use client';

/**
 * Client gate around `BidComposer` for private RFPs. If the connected wallet
 * has a cached private bid for this RFP (localStorage), redirect to the RFP
 * page where `YourBidPanel` handles the existing-bid view inline. Otherwise
 * render the composer for a fresh bid.
 *
 * For public RFPs the equivalent check happens server-side on the /bid page
 * and triggers `redirect()` directly - no client gate needed there.
 */
import { useSelectedWalletAccount } from '@solana/react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { BidComposer } from '@/components/rfp/bid-composer';

export interface PrivateBidComposeGateProps {
  rfpId: string;
  rfpPda: string;
  rfpNonceHex: string;
  buyerEncryptionPubkeyHex: string;
  hasReserve?: boolean;
  feeBps: number;
}

export function PrivateBidComposeGate(props: PrivateBidComposeGateProps) {
  const [account] = useSelectedWalletAccount();
  const router = useRouter();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (!account) return;
    try {
      const key = `tender:bid:${props.rfpPda}:${account.address}`;
      const cached = localStorage.getItem(key);
      if (!cached) return;
      const j = JSON.parse(cached) as { bidPda?: string };
      if (j.bidPda) {
        setRedirecting(true);
        router.replace(`/rfps/${props.rfpId}`);
      }
    } catch {
      /* ignore */
    }
  }, [account, props.rfpId, props.rfpPda, router]);

  if (redirecting) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
        You already have a bid here - taking you to it…
      </div>
    );
  }

  return (
    <BidComposer
      rfpId={props.rfpId}
      rfpPda={props.rfpPda}
      rfpNonceHex={props.rfpNonceHex}
      bidderVisibility="buyer_only"
      buyerEncryptionPubkeyHex={props.buyerEncryptionPubkeyHex}
      hasReserve={props.hasReserve}
      feeBps={props.feeBps}
    />
  );
}
