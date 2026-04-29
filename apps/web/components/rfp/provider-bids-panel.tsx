'use client';

import {
  useSelectedWalletAccount,
  useSignMessage,
  useWalletAccountTransactionSendingSigner,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { KeyRoundIcon, LockKeyholeIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { RevealGlow, UnlockField } from '@/components/motion/reveal-glow';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import { withdrawBid } from '@/lib/bids/withdraw-flow';
import {
  deriveProviderKeypair,
  deriveProviderSeedMessage,
} from '@/lib/crypto/derive-provider-keypair';
import { decryptBid } from '@/lib/crypto/ecies';
import { rpc } from '@/lib/solana/client';
import { cn } from '@/lib/utils';

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
  plaintext: SealedBidPlaintext | null;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ProviderBidsPanel({ profileWallet }: { profileWallet: string }) {
  const [account] = useSelectedWalletAccount();
  const [hydrated, setHydrated] = useState(false);

  // Wait one paint before deciding which branch to render. `useSelectedWalletAccount`
  // returns undefined on the very first client render — without this defer, we'd
  // briefly show the "sealed / not your bids" message before the wallet hook
  // populates, which produces a 3-step visual flicker on every mount.
  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) {
    return <BidsPanelSkeleton />;
  }

  const isOwnProfile = account?.address === profileWallet;

  if (!isOwnProfile || !account) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="text-base">Bid plaintexts</CardTitle>
          <StatusPill tone="sealed">sealed</StatusPill>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Only the provider whose wallet posted the bids can decrypt them. Connect that wallet
            from the top right and revisit this profile.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <Connected profileWallet={profileWallet} account={account} />;
}

/**
 * Used both during wallet-hydration grace and during the bids fetch — same
 * footprint either way so the loading → loaded transition holds layout.
 */
function BidsPanelSkeleton() {
  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <LockKeyholeIcon className="size-4 text-muted-foreground" />
          Your bids
        </CardTitle>
        <Skeleton className="h-9 w-32 rounded-full" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-4 w-3/4" />
        <BidSkeleton />
      </CardContent>
    </Card>
  );
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
    return <BidsPanelSkeleton />;
  }

  if (bids.length === 0) {
    return (
      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LockKeyholeIcon className="size-4 text-muted-foreground" />
            Your bids
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No bids yet.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-colors duration-700',
        revealed
          ? 'border-primary/40 bg-gradient-to-br from-card via-card to-primary/8'
          : 'border-border/60',
      )}
    >
      {revealed && (
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-12 size-72 rounded-full bg-primary/15 blur-3xl"
        />
      )}
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {revealed ? (
            <KeyRoundIcon className="size-4 text-primary" />
          ) : (
            <LockKeyholeIcon className="size-4 text-muted-foreground" />
          )}
          Your bids
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({bids.length})
          </span>
        </CardTitle>
        {!revealed && (
          <Button
            onClick={reveal}
            disabled={revealing}
            size="sm"
            className="h-9 gap-2 rounded-full px-4 shadow-md shadow-primary/25"
          >
            <KeyRoundIcon className="size-3.5" />
            {revealing ? 'Decrypting…' : 'Reveal my bids'}
          </Button>
        )}
        {revealed && <StatusPill tone="reveal">decrypted in-memory</StatusPill>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {revealed
            ? 'Plaintexts live only in this browser tab. Refresh the page and they re-seal automatically.'
            : 'Click reveal once → wallet signs the derive-key message → plaintexts decrypt in-browser. Plaintexts are never stored anywhere.'}
        </p>
        <RevealGlow active={revealed}>
          <div className="flex flex-col gap-3">
            {bids.map((b) => (
              <BidCard
                key={b.on_chain_pda}
                bid={b}
                revealed={revealed}
                withdrawing={withdrawing === b.on_chain_pda}
                onWithdraw={() => handleWithdraw(b)}
              />
            ))}
          </div>
        </RevealGlow>
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
  const showPlaintext = revealed && bid.plaintext;

  return (
    <div
      className={cn(
        'relative flex flex-col gap-3 overflow-hidden rounded-xl border p-4 transition-colors duration-500',
        showPlaintext
          ? 'border-primary/30 bg-card shadow-sm shadow-primary/5'
          : 'border-dashed border-border/60 bg-card/40',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          rfp ·{' '}
          <HashLink
            hash={bid.rfp_pda}
            href={`/rfps/${bid.rfp_pda}`}
            external={false}
            visibleChars={6}
          />
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          <LocalTime iso={bid.submitted_at} />
        </span>
      </div>

      {!revealed && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          commit_hash ·{' '}
          <HashLink hash={bid.commit_hash_hex} kind="none" visibleChars={8} />
        </div>
      )}

      {showPlaintext && bid.plaintext && (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
          <UnlockField delay={0}>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Price
                </span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  ${Number(bid.plaintext.priceUsdc).toLocaleString()}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">USDC</span>
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Timeline
                </span>
                <span className="font-mono text-base font-semibold tabular-nums">
                  {bid.plaintext.timelineDays}
                  <span className="ml-1 text-[10px] font-normal text-muted-foreground">days</span>
                </span>
              </div>
            </div>
          </UnlockField>

          <UnlockField delay={0.1}>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Scope
              </span>
              <p className="text-xs leading-relaxed text-foreground/90">{bid.plaintext.scope}</p>
            </div>
          </UnlockField>

          <UnlockField delay={0.2}>
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Milestones · {bid.plaintext.milestones.length}
              </span>
              <ul className="flex flex-col gap-1 rounded-lg border border-dashed border-border/60 bg-card/40 p-2.5">
                {bid.plaintext.milestones.map((m, i) => (
                  <li
                    key={`${bid.on_chain_pda}-${i}`}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span>
                      <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>{' '}
                      {m.name}
                    </span>
                    <span className="font-mono tabular-nums">
                      ${Number(m.amountUsdc).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </UnlockField>
        </div>
      )}

      {revealed && !bid.plaintext && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          Decryption failed. Wrong wallet or corrupted ciphertext.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <DataField
          label="bid PDA"
          value={<HashLink hash={bid.on_chain_pda} kind="account" />}
          className="flex-1"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={withdrawing}
          onClick={onWithdraw}
          className="h-8 rounded-full px-4"
        >
          {withdrawing ? 'Withdrawing…' : 'Withdraw'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Placeholder bid card that matches the real BidCard's footprint, so the
 * loading → loaded transition holds layout (no width or height jump).
 */
function BidSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border/60 bg-card/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-3 w-3/4" />
      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
    </div>
  );
}
