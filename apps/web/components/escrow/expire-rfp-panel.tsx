'use client';

/**
 * Permissionless "Mark RFP expired" action surface.
 *
 * Renders only when the RFP's reveal window has closed without an award
 * (status is still BidsClosed/Reveal, but now > reveal_close_at). This is
 * the deadlock case: select_bid would revert with RevealWindowExpired,
 * leaving the RFP stuck. expire_rfp is permissionless - any signed-in
 * wallet can fire it (the buyer being the most natural caller, but a
 * stuck provider can self-rescue too).
 *
 * Intentionally a separate component (vs. living inside BuyerActionPanel)
 * because the action is for ANY visitor, not just the buyer or winning
 * provider.
 */
import type { Address } from '@solana/kit';
import { useSelectedWalletAccount, useSignTransactions } from '@solana/react';
import { TimerOffIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { friendlyBidError } from '@/lib/bids/error-utils';
import { expireRfp } from '@/lib/escrow/milestone-flow';
import { rpc } from '@/lib/solana/client';

export interface ExpireRfpPanelProps {
  rfpPda: string;
  rfpStatus: string;
  /** ISO timestamp of `rfp.reveal_close_at`. */
  revealCloseAtIso: string;
  /** Wallet that created the RFP. Used only for tone (we soften the message
   *  if the viewer IS the buyer). The action itself is permissionless. */
  buyerWallet: string;
}

export function ExpireRfpPanel(props: ExpireRfpPanelProps) {
  // Only render when the RFP is in the deadlock window.
  if (props.rfpStatus !== 'bidsclosed' && props.rfpStatus !== 'reveal') return null;
  if (new Date(props.revealCloseAtIso).getTime() > Date.now()) return null;
  return <Body {...props} />;
}

function Body(props: ExpireRfpPanelProps) {
  const [account] = useSelectedWalletAccount();
  // Render the explanatory card for any visitor; gate only the action button
  // on a connected wallet (the on-chain ix needs a signer regardless).
  return account ? (
    <Connected account={account} {...props} />
  ) : (
    <Shell isBuyer={false}>
      <Button type="button" size="sm" disabled className="bg-amber-600 text-amber-50">
        Connect a wallet to expire
      </Button>
    </Shell>
  );
}

function Connected({ account, ...props }: ExpireRfpPanelProps & { account: { address: string } }) {
  const router = useRouter();
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook narrowing
  const signTransactions = useSignTransactions(account as any, 'solana:devnet');
  const [busy, setBusy] = useState(false);
  const isBuyer = account.address === props.buyerWallet;

  async function handleClick() {
    setBusy(true);
    try {
      const sig = await expireRfp({
        signer: account.address as Address,
        rfpPda: props.rfpPda as Address,
        // biome-ignore lint/suspicious/noExplicitAny: hook return shape
        signTransactions: signTransactions as any,
        rpc,
      });
      toast.success('RFP marked expired', {
        description: <TxToastDescription hash={sig} prefix="Tx" />,
      });
      router.refresh();
    } catch (e) {
      toast.error('Expire failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell isBuyer={isBuyer}>
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={handleClick}
        className="bg-amber-600 text-amber-50 hover:bg-amber-700"
      >
        {busy ? 'Expiring...' : 'Mark RFP expired'}
      </Button>
    </Shell>
  );
}

function Shell({ isBuyer, children }: { isBuyer: boolean; children: React.ReactNode }) {
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TimerOffIcon className="size-4 text-amber-700 dark:text-amber-400" />
          Reveal window expired without an award
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          {isBuyer
            ? "You didn't pick a winner before the reveal window closed. The RFP is stuck — select_bid will revert."
            : 'The buyer never picked a winner before the reveal window closed. The RFP is stuck — no one can be awarded now.'}{' '}
          Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">expire_rfp</code>{' '}
          to terminate it cleanly. Permissionless — any signed-in wallet can fire it. No funds or
          rent move; the RFP just flips to a terminal{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">Expired</code> state.
        </p>
        <div className="flex justify-end">{children}</div>
      </CardContent>
    </Card>
  );
}
