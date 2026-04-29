'use client';

import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const sendingSigner = useWalletAccountTransactionSendingSigner(props.account, 'solana:devnet');
  const router = useRouter();
  const [withdrawing, setWithdrawing] = useState(false);

  async function handleWithdraw() {
    setWithdrawing(true);
    try {
      const result = await withdrawBid({
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        rfpPda: props.rfpPda as any,
        bidPda: props.bidPda,
        sendingSigner,
        rpc,
        onProgress: () => undefined,
      });
      toast.success('Bid withdrawn', {
        description: `tx ${result.txSignature.slice(0, 8)}…`,
        duration: 8000,
      });
      router.refresh();
    } catch (e) {
      toast.error('Withdraw failed', { description: (e as Error).message, duration: 12000 });
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">You&rsquo;ve already bid on this RFP</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Each provider can have one active bid per RFP. To submit a different proposal, withdraw
          this one first and then re-bid.
        </p>

        <div className="flex flex-col gap-2 rounded border border-dashed border-border p-3 font-mono text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">bid PDA</span>
            <Link
              href={`https://solscan.io/account/${props.bidPda}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline"
            >
              {props.bidPda.slice(0, 8)}…{props.bidPda.slice(-8)}
            </Link>
          </div>
          {props.txSignature && (
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">commit tx</span>
              <Link
                href={`https://solscan.io/tx/${props.txSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline"
              >
                {props.txSignature.slice(0, 8)}…{props.txSignature.slice(-8)}
              </Link>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">commit hash</span>
            <span className="break-all">{props.commitHashHex.slice(0, 16)}…</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">submitted</span>
            <span>
              <LocalTime iso={props.submittedAt} />
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href={`/providers/${props.account.address}`}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:bg-card"
          >
            View bid plaintext (your profile)
          </Link>
          <Button variant="outline" disabled={withdrawing} onClick={handleWithdraw}>
            {withdrawing ? 'Withdrawing…' : 'Withdraw bid'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
