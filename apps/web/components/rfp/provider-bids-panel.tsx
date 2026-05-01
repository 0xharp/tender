'use client';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Address, getAddressEncoder } from '@solana/kit';
import {
  useSelectedWalletAccount,
  useSignMessage,
  useSignTransactions,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { accounts } from '@tender/tender-client';
import { InfoIcon, KeyRoundIcon, LockKeyholeIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { friendlyBidError } from '@/lib/bids/error-utils';
import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import { withdrawBid } from '@/lib/bids/withdraw-flow';
import {
  deriveProviderKeypair,
  deriveProviderSeedMessage,
} from '@/lib/crypto/derive-provider-keypair';
import { decryptBid } from '@/lib/crypto/ecies';
import {
  ensureTeeAuthToken,
  ephemeralRpc,
  fetchDelegatedAccountBytes,
} from '@/lib/sdks/magicblock';
import { listBids, unixSecondsToIso } from '@/lib/solana/chain-reads';
import { rpc } from '@/lib/solana/client';
import { cn } from '@/lib/utils';

const addressEncoder = getAddressEncoder();

/** Slim shape derived from the on-chain BidCommit account. Replaces the
 *  earlier "ApiBid" pulled from supabase. */
interface BidView {
  on_chain_pda: string;
  rfp_pda: string;
  bidder_visibility: 'public' | 'buyer_only';
  commit_hash_hex: string;
  submitted_at: string;
}

interface DecryptedBid extends BidView {
  plaintext: SealedBidPlaintext | null;
  /** Decryption failed for a known reason (e.g. provider envelope absent or wrong wallet). */
  decryptError?: string;
}

export function ProviderBidsPanel({ profileWallet }: { profileWallet: string }) {
  const [account] = useSelectedWalletAccount();
  const [hydrated, setHydrated] = useState(false);

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
  // Batched sign for the 2-tx withdraw flow (ER undelegate + base-layer close).
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const router = useRouter();

  const [bids, setBids] = useState<DecryptedBid[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Read directly from on-chain — getProgramAccounts with memcmp filter on
      // the BidCommit's `provider_identity` field. L0 (Plain pubkey) and L1
      // (Hashed sha256) live at the same offset but different tag values, so
      // we issue two queries and merge.
      const walletBytes = new Uint8Array(addressEncoder.encode(profileWallet as Address));
      const walletHash = sha256(walletBytes);

      const [l0Bids, l1Bids] = await Promise.all([
        listBids({ providerWallet: profileWallet as Address }),
        listBids({ providerWalletHash: walletHash }),
      ]);

      const merged = new Map<string, BidView>();
      for (const b of [...l0Bids, ...l1Bids]) {
        merged.set(b.address, {
          on_chain_pda: b.address,
          rfp_pda: b.data.rfp,
          bidder_visibility:
            (b.data.providerIdentity as { __kind: string }).__kind === 'Plain'
              ? 'public'
              : 'buyer_only',
          commit_hash_hex: bytesToHex(new Uint8Array(b.data.commitHash)),
          submitted_at: unixSecondsToIso(b.data.submittedAt),
        });
      }

      setBids(Array.from(merged.values()).map((r) => ({ ...r, plaintext: null })));
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
      // 1. Derive provider X25519 keypair (one wallet popup, cached client-side).
      const seedMsg = deriveProviderSeedMessage();
      const { signature } = await signMessage({ message: seedMsg });
      const kp = deriveProviderKeypair(signature);

      // 2. Get TEE auth token + ER RPC client.
      const teeToken = await ensureTeeAuthToken(account.address as Address, async (msg) => {
        const { signature: sig } = await signMessage({ message: msg });
        return sig;
      });
      const erRpc = ephemeralRpc(teeToken);

      // 3. For each bid: read BidCommit from ER, decrypt provider_envelope.
      const next: DecryptedBid[] = await Promise.all(
        bids.map(async (b) => {
          const raw = await fetchDelegatedAccountBytes(b.on_chain_pda as Address, erRpc);
          if (!raw) {
            return {
              ...b,
              plaintext: null,
              decryptError: 'PER permission denied or account not found.',
            };
          }
          try {
            const decoded = accounts.getBidCommitDecoder().decode(raw);
            const providerEnvelope = decoded.providerEnvelope as Uint8Array;
            const json = new TextDecoder().decode(decryptBid(providerEnvelope, kp.x25519PrivateKey));
            const parsed = sealedBidPlaintextSchema.safeParse(JSON.parse(json));
            return {
              ...b,
              plaintext: parsed.success ? parsed.data : null,
              decryptError: parsed.success ? undefined : 'Plaintext failed schema validation.',
            };
          } catch (e) {
            return { ...b, plaintext: null, decryptError: (e as Error).message };
          }
        }),
      );

      setBids(next);
      setRevealed(true);
      const decryptedCount = next.filter((b) => b.plaintext !== null).length;
      toast.success(`Decrypted ${decryptedCount} of ${next.length} bid(s)`);
    } catch (e) {
      toast.error('Reveal failed', { description: friendlyBidError(e) });
    } finally {
      setRevealing(false);
    }
  }

  async function handleWithdraw(b: DecryptedBid) {
    setWithdrawing(b.on_chain_pda);
    try {
      const result = await withdrawBid({
        bidPda: b.on_chain_pda as Address,
        rfpPda: b.rfp_pda as Address,
        providerWallet: account.address as Address,
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
      await refresh();
      // Re-run server components on the page so server-rendered counts (e.g.
      // the "Reputation" card on /providers/[wallet]) refresh too. Without
      // this they stay stale until a manual reload.
      router.refresh();
    } catch (e) {
      toast.error('Withdraw failed', {
        description: friendlyBidError(e),
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
            : 'Click reveal → wallet signs derive-key + TEE auth → bids fetched from MagicBlock PER → plaintexts decrypted in-browser. Plaintexts are never stored anywhere.'}
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
          {bid.bidder_visibility === 'buyer_only' && (
            <StatusPill tone="sealed">private</StatusPill>
          )}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          <LocalTime iso={bid.submitted_at} />
        </span>
      </div>

      {!revealed && (
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          commit_hash
          <Tooltip>
            <TooltipTrigger
              render={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label="What is commit_hash?"
                  className="inline-flex cursor-help items-center text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <InfoIcon className="size-3" />
                </button>
              )}
            />
            <TooltipContent className="max-w-[260px] text-[11px] leading-relaxed">
              sha256 of the encrypted bid envelopes. The on-chain integrity check — any tampering
              with the bytes on the rollup would fail this hash.
            </TooltipContent>
          </Tooltip>
          · <HashLink hash={bid.commit_hash_hex} kind="none" visibleChars={8} />
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
          Decryption failed.{bid.decryptError ? ` ${bid.decryptError}` : ''}
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
