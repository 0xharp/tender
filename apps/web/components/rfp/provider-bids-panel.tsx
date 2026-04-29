'use client';

import {
  useSelectedWalletAccount,
  useSignMessage,
  useWalletAccountTransactionSendingSigner,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import { withdrawBid } from '@/lib/bids/withdraw-flow';
import {
  deriveProviderKeypair,
  deriveProviderSeedMessage,
} from '@/lib/crypto/derive-provider-keypair';
import { decryptBid } from '@/lib/crypto/ecies';
import { rpc } from '@/lib/solana/client';

/** Server returns canonical base64 strings for both ciphertexts (see /api/bids GET). */
interface ApiBid {
  id: string;
  on_chain_pda: string;
  rfp_id: string;
  rfp_pda: string;
  provider_wallet: string;
  ephemeral_pubkey_hex: string;
  commit_hash_hex: string;
  ciphertext_base64: string | null;
  provider_ephemeral_pubkey_hex: string | null;
  provider_ciphertext_base64: string | null;
  storage_backend: string;
  per_session_id: string | null;
  submitted_at: string;
}

interface DecryptedBid extends ApiBid {
  plaintext: SealedBidPlaintext | null; // null = couldn't decrypt (no provider_ciphertext, or wrong key)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ProviderBidsPanel({ profileWallet }: { profileWallet: string }) {
  const [account] = useSelectedWalletAccount();
  const isOwnProfile = account?.address === profileWallet;

  if (!isOwnProfile || !account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bid plaintexts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Sealed. Only the provider whose wallet posted the bids can decrypt them — connect that
            wallet from the top-right and revisit this profile.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <Connected profileWallet={profileWallet} account={account} />;
}

function Connected({
  profileWallet,
  account,
}: {
  profileWallet: string;
  account: UiWalletAccount;
}) {
  const signMessage = useSignMessage(account);
  const sendingSigner = useWalletAccountTransactionSendingSigner(account, 'solana:devnet');

  const [bids, setBids] = useState<DecryptedBid[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bids?provider_wallet=${profileWallet}`);
      if (!res.ok) {
        toast.error('Failed to load bids');
        return;
      }
      const { bids: rows } = (await res.json()) as { bids: ApiBid[] };
      setBids(rows.map((r) => ({ ...r, plaintext: null })));
      setRevealed(false);
    } finally {
      setLoading(false);
    }
  }, [profileWallet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function reveal() {
    setRevealing(true);
    try {
      const seedMsg = deriveProviderSeedMessage();
      const { signature } = await signMessage({ message: seedMsg });
      const kp = deriveProviderKeypair(signature);

      const next: DecryptedBid[] = bids.map((b) => {
        if (!b.provider_ciphertext_base64) return { ...b, plaintext: null };
        try {
          const ct = base64ToBytes(b.provider_ciphertext_base64);
          const json = new TextDecoder().decode(decryptBid(ct, kp.x25519PrivateKey));
          const parsed = sealedBidPlaintextSchema.safeParse(JSON.parse(json));
          return { ...b, plaintext: parsed.success ? parsed.data : null };
        } catch {
          return { ...b, plaintext: null };
        }
      });
      setBids(next);
      setRevealed(true);
      const decryptedCount = next.filter((b) => b.plaintext !== null).length;
      toast.success(`Decrypted ${decryptedCount} of ${next.length} bid(s)`);
    } catch (e) {
      toast.error('Reveal failed', { description: (e as Error).message });
    } finally {
      setRevealing(false);
    }
  }

  async function handleWithdraw(b: DecryptedBid) {
    setWithdrawing(b.on_chain_pda);
    try {
      const result = await withdrawBid({
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        rfpPda: b.rfp_pda as any,
        bidPda: b.on_chain_pda,
        sendingSigner,
        rpc,
        onProgress: () => undefined,
      });
      toast.success('Bid withdrawn', {
        description: `tx ${result.txSignature.slice(0, 8)}…`,
        duration: 8000,
      });
      await refresh();
    } catch (e) {
      toast.error('Withdraw failed', {
        description: (e as Error).message,
        duration: 12000,
      });
    } finally {
      setWithdrawing(null);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your bids</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading…</p>
        </CardContent>
      </Card>
    );
  }

  if (bids.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your bids</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No bids yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Your bids ({bids.length})</CardTitle>
        {!revealed && (
          <Button onClick={reveal} disabled={revealing} size="sm">
            {revealing ? 'Decrypting…' : 'Reveal my bids'}
          </Button>
        )}
        {revealed && (
          <span className="text-xs text-muted-foreground">
            decrypted in-memory · refresh to re-seal
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          Bids are sealed by default. Click reveal once → wallet signs the derive-key message →
          plaintexts decrypt in your browser memory only. Plaintexts are never stored anywhere.
        </p>
        {bids.map((b) => (
          <BidCard
            key={b.on_chain_pda}
            bid={b}
            revealed={revealed}
            withdrawing={withdrawing === b.on_chain_pda}
            onWithdraw={() => handleWithdraw(b)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function BidCard({
  bid,
  revealed,
  withdrawing,
  onWithdraw,
}: {
  bid: DecryptedBid;
  revealed: boolean;
  withdrawing: boolean;
  onWithdraw: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-dashed border-border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          href={`/rfps/${bid.rfp_pda}`}
          className="text-sm font-medium underline underline-offset-4"
        >
          rfp {bid.rfp_pda.slice(0, 8)}…{bid.rfp_pda.slice(-4)}
        </Link>
        <span className="text-xs text-muted-foreground">
          <LocalTime iso={bid.submitted_at} />
        </span>
      </div>

      {!revealed && (
        <p className="font-mono text-xs text-muted-foreground">
          commit_hash {bid.commit_hash_hex.slice(0, 16)}…{bid.commit_hash_hex.slice(-16)}
        </p>
      )}

      {revealed && bid.plaintext && (
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">price</span>
            <span className="font-mono">
              ${Number(bid.plaintext.priceUsdc).toLocaleString()} USDC
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-muted-foreground">timeline</span>
            <span>{bid.plaintext.timelineDays} days</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">scope</span>
            <p className="line-clamp-3 text-foreground">{bid.plaintext.scope}</p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              milestones ({bid.plaintext.milestones.length})
            </span>
            <ul className="flex flex-col gap-0.5">
              {bid.plaintext.milestones.map((m, i) => (
                <li
                  key={`${bid.on_chain_pda}-${i}`}
                  className="flex items-baseline justify-between"
                >
                  <span>
                    {i + 1}. {m.name}
                  </span>
                  <span className="font-mono">${Number(m.amountUsdc).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {revealed && !bid.plaintext && (
        <p className="text-xs text-destructive">
          Decryption failed. Wrong wallet or corrupted ciphertext.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
        <Link
          href={`https://solscan.io/account/${bid.on_chain_pda}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs underline"
        >
          bid PDA ↗
        </Link>
        <Button variant="outline" size="sm" disabled={withdrawing} onClick={onWithdraw}>
          {withdrawing ? 'Withdrawing…' : 'Withdraw'}
        </Button>
      </div>
    </div>
  );
}
