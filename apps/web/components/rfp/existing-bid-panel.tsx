'use client';

import { useSignMessage, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { friendlyBidError } from '@/lib/bids/error-utils';
import { withdrawBid } from '@/lib/bids/withdraw-flow';
import { rpc } from '@/lib/solana/client';

export interface ExistingBidPanelProps {
  rfpPda: string;
  bidPda: string;
  commitHashHex: string;
  submittedAt: string;
  txSignature?: string | null;
  account: UiWalletAccount;
}

export function ExistingBidPanel(props: ExistingBidPanelProps) {
  // Batched sign — withdraw-flow now needs two txs (ER undelegate + base-layer
  // close) signed in one popup, then dispatched to different RPCs.
  const signTransactions = useSignTransactions(props.account, 'solana:devnet');
  const signMessage = useSignMessage(props.account);
  const router = useRouter();
  const [withdrawing, setWithdrawing] = useState(false);

  async function handleWithdraw() {
    setWithdrawing(true);
    try {
      const result = await withdrawBid({
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        bidPda: props.bidPda as any,
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        rfpPda: props.rfpPda as any,
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        providerWallet: props.account.address as any,
        // biome-ignore lint/suspicious/noExplicitAny: kit signer narrowing at hook site
        signMessage: signMessage as any,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        rpc,
        onProgress: () => undefined,
      });
      toast.success('Bid withdrawn', {
        description: `tx ${result.txSignature.slice(0, 8)}…`,
        duration: 8000,
      });
      router.refresh();
    } catch (e) {
      toast.error('Withdraw failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-br from-card via-card to-primary/5">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-12 -right-12 size-40 rounded-full bg-primary/15 blur-3xl"
      />
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="text-base">You&rsquo;ve already bid on this RFP</CardTitle>
        <StatusPill tone="sealed">sealed</StatusPill>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Each provider can have one active bid per RFP. To submit a different proposal, withdraw
          this one first and re-bid.
        </p>

        <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border/60 bg-card/40 p-4 backdrop-blur-sm">
          <DataField label="bid PDA" value={<HashLink hash={props.bidPda} kind="account" />} />
          {props.txSignature && (
            <DataField label="commit tx" value={<HashLink hash={props.txSignature} kind="tx" />} />
          )}
          <DataField
            label="commit hash"
            hint="sha256 of your two encrypted bid envelopes. The on-chain integrity check — any tampering with the envelopes on PER would fail this hash."
            value={<HashLink hash={props.commitHashHex} kind="none" visibleChars={8} />}
          />
          <DataField label="submitted" value={<LocalTime iso={props.submittedAt} />} mono={false} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={`/providers/${props.account.address}`}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-border bg-card/60 px-4 text-sm font-medium transition-colors hover:bg-card"
          >
            View bid plaintext (your profile) <ArrowUpRightIcon className="size-3.5" />
          </Link>
          <Button
            variant="outline"
            disabled={withdrawing}
            onClick={handleWithdraw}
            className="h-9 rounded-full border-border px-4"
          >
            {withdrawing ? 'Withdrawing…' : 'Withdraw bid'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
