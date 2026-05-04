'use client';

/**
 * Renders on the RFP detail page (private mode only) when the connected
 * wallet has a known ephemeral wallet for this RFP that holds non-trivial
 * SOL. Lets the user sweep funds back to their main wallet via Cloak's
 * shielded pool - no on-chain link.
 *
 * Useful in three scenarios:
 *   - User funded ephemeral with too much SOL and wants the excess back
 *   - User decided not to bid after funding
 *   - User wants to clear the ephemeral wallet after their bid completed
 *     (won + paid, OR lost + abandoned)
 *
 * Resolution: reads localStorage cache (no popup). Only renders when:
 *   1. User is connected
 *   2. RFP is private mode (passed in from server)
 *   3. There's a cached ephemeral pubkey for this (wallet, rfp)
 *   4. That ephemeral wallet holds > 0.005 SOL on chain
 */
import { useSelectedWalletAccount, useSignMessage } from '@solana/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { HashLink } from '@/components/primitives/hash-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import {
  deriveEphemeralBidKeypair,
  deriveEphemeralBidWalletMessage,
} from '@/lib/crypto/derive-ephemeral-bid-wallet';

export interface SweepEphemeralPanelProps {
  rfpPda: string;
  bidderVisibility: 'public' | 'buyer_only';
}

export function SweepEphemeralPanel(props: SweepEphemeralPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  if (props.bidderVisibility !== 'buyer_only') return null;
  return <Connected account={account} {...props} />;
}

function Connected({
  account,
  rfpPda,
}: {
  account: NonNullable<ReturnType<typeof useSelectedWalletAccount>[0]>;
} & SweepEphemeralPanelProps) {
  const signMessage = useSignMessage(account);
  const [ephemeralPubkey, setEphemeralPubkey] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<string | null>(null);
  const [doneSig, setDoneSig] = useState<string | null>(null);

  // Resolve ephemeral pubkey from localStorage cache. No wallet popup here -
  // if the cache is empty (user never bid or never verified), we just don't
  // show the panel.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const cached = localStorage.getItem(`tender:bid:${rfpPda}:${account.address}`);
    if (!cached) {
      setEphemeralPubkey(null);
      return;
    }
    try {
      const j = JSON.parse(cached) as { ephemeralPubkey: string };
      setEphemeralPubkey(j.ephemeralPubkey);
    } catch {
      setEphemeralPubkey(null);
    }
  }, [rfpPda, account.address]);

  // Poll the ephemeral balance every 5s so the panel auto-shows when funds
  // arrive (e.g., post-withdraw refund) and auto-hides when swept.
  useEffect(() => {
    if (!ephemeralPubkey) return;
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | null = null;
    async function check() {
      try {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const conn = new Connection(
          process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? 'https://api.devnet.solana.com',
          'confirmed',
        );
        const lamports = await conn.getBalance(new PublicKey(ephemeralPubkey!));
        if (!cancelled) setBalance(lamports / 1e9);
      } catch {
        /* ignore */
      }
    }
    void check();
    id = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [ephemeralPubkey]);

  async function handleSweep() {
    if (!ephemeralPubkey) return;
    setSweeping(true);
    try {
      const seedMsg = deriveEphemeralBidWalletMessage(rfpPda);
      // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
      const seedSig = await (signMessage as any)({ message: seedMsg });
      const eph = await deriveEphemeralBidKeypair(seedSig.signature);
      if (eph.publicKey.toBase58() !== ephemeralPubkey) {
        throw new Error('Derived ephemeral pubkey mismatch');
      }
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const conn = new Connection(
        process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? 'https://api.devnet.solana.com',
        'confirmed',
      );
      const lamports = await conn.getBalance(new PublicKey(ephemeralPubkey));
      // The ephemeral signs Cloak's deposit tx, so it needs to fund:
      // - tx fee (~0.000005 SOL)
      // - Cloak deposit-side fee (~0.005 SOL - observed from funding flow)
      // - any first-touch rent (~0.002 SOL ATA, sometimes)
      // 0.01 SOL reserve is a safe upper bound; the Cloak SDK's preflight
      // check fails with "Insufficient SOL on the signer wallet" if too tight.
      const RESERVE_LAMPORTS = 10_000_000n; // 0.01 SOL
      const sweepAmount =
        BigInt(lamports) > RESERVE_LAMPORTS ? BigInt(lamports) - RESERVE_LAMPORTS : 0n;
      if (sweepAmount < 5_000_000n) {
        throw new Error(
          `Not enough SOL to sweep. Balance ${(lamports / 1e9).toFixed(4)} SOL, need > 0.015 SOL (reserves 0.01 SOL on ephemeral for Cloak deposit fees).`,
        );
      }
      const { sweepEphemeralToDestination } = await import('@/lib/sdks/cloak');
      const result = await sweepEphemeralToDestination({
        ephemeralKeypair: eph,
        destinationPubkey: new PublicKey(account.address),
        sweepLamports: sweepAmount,
        connection: conn,
        onProgress: (p) => setSweepProgress(p.stage),
      });
      setDoneSig(result.withdrawSig);
      toast.success('Funds swept to your main wallet via Cloak', {
        description: `${(Number(sweepAmount) / 1e9).toFixed(4)} SOL - withdraw ${result.withdrawSig.slice(0, 12)}…`,
        duration: 10000,
      });
    } catch (e) {
      toast.error('Sweep failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setSweeping(false);
      setSweepProgress(null);
    }
  }

  if (!ephemeralPubkey) return null;
  if (balance === null) return null;
  // < 0.015 SOL → after the 0.01 SOL ephemeral-side reserve and Cloak's
  // ~0.005 SOL withdraw-side fee, less than ~0 lands on the destination.
  if (balance < 0.015) return null;
  if (doneSig) {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ephemeral funds swept</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <span className="text-muted-foreground">Returned to your main wallet via Cloak - </span>
          <HashLink hash={doneSig} kind="tx" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Sweep ephemeral funds back to your main wallet</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        <p className="text-muted-foreground">
          Your privacy wallet for this RFP holds{' '}
          <span className="font-mono text-foreground">{balance.toFixed(4)} SOL</span>. Sweep it back
          to your main wallet via Cloak's shielded pool - no on-chain link between the two. Reserves
          ~0.01 SOL on the ephemeral for the Cloak deposit-side fee, and ~0.005 SOL is taken on the
          withdraw side. You'll receive approximately{' '}
          <span className="font-mono text-foreground">
            {Math.max(0, balance - 0.015).toFixed(4)} SOL
          </span>
          .
        </p>
      </CardContent>
      <CardFooter className="flex items-center justify-between gap-3 border-t border-border/40 pt-3">
        <span className="font-mono text-[10px] text-muted-foreground">
          ephemeral: <HashLink hash={ephemeralPubkey} kind="account" visibleChars={4} />
        </span>
        <Button type="button" disabled={sweeping} onClick={handleSweep} className="min-w-[14rem]">
          {sweeping ? humanizeStage(sweepProgress, 'Sweeping') : 'Sweep to main via Cloak'}
        </Button>
      </CardFooter>
    </Card>
  );
}
