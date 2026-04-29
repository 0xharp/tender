'use client';

import { useSelectedWalletAccount } from '@solana/react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { ExistingBidPanel } from './existing-bid-panel';

interface ExistingBidGateProps {
  rfpPda: string;
  bidPda: string;
  commitHashHex: string;
  submittedAt: string;
  txSignature?: string | null;
  expectedProviderWallet: string;
}

/**
 * Server has determined that some bid for this (rfp, provider_wallet) exists.
 * This client wrapper grabs the connected `UiWalletAccount` (needed by the
 * withdraw flow) and verifies it matches the wallet the server saw. If the
 * user has switched wallets between sign-in and now, we surface that.
 */
export function ExistingBidGate(props: ExistingBidGateProps) {
  const [account] = useSelectedWalletAccount();

  if (!account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Re-connect your wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You have an existing bid on this RFP. Connect the same wallet to withdraw it.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (account.address !== props.expectedProviderWallet) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Wallet mismatch</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You&rsquo;re signed in as{' '}
            <span className="font-mono">{props.expectedProviderWallet.slice(0, 6)}…</span> (which
            has an existing bid on this RFP), but the connected wallet is{' '}
            <span className="font-mono">{account.address.slice(0, 6)}…</span>. Switch wallets to
            manage that bid.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <ExistingBidPanel
      rfpPda={props.rfpPda}
      bidPda={props.bidPda}
      commitHashHex={props.commitHashHex}
      submittedAt={props.submittedAt}
      txSignature={props.txSignature}
      account={account}
    />
  );
}
