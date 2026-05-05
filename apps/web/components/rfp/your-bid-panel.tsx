'use client';

/**
 * The single canonical "your bid on this RFP" surface. Lives inline on the
 * RFP detail page (`/rfps/[id]`). Replaces the older split between
 * BidStatusCta + ExistingBidGate/Panel + PrivateBidWorkspace + the in-panel
 * decrypt UI on the provider profile.
 *
 * Detection (zero popups in the happy path):
 *   - Public mode: server passes `existingBid` from the chain query
 *     (bid.provider == viewer's main wallet). Renders inline immediately.
 *   - Private mode: localStorage cache holds {ephemeralPubkey, bidPda} from
 *     the bid composer. If absent, we surface a "Check if I bid here" button
 *     (one popup → derives the deterministic ephemeral wallet + queries chain).
 *
 * Actions in this single panel:
 *   - Reveal - first click pops a wallet popup to derive the X25519 keypair
 *     + TEE auth; subsequent reveals/hides are instant. Decrypted plaintext
 *     stays in tab memory (refresh re-seals).
 *   - Withdraw - public mode signs with main wallet (one batched popup);
 *     private mode signs locally with the deterministic ephemeral keypair
 *     (one popup to re-derive, then no further popups).
 *   - Hide - clears the in-memory plaintext.
 *
 * This is the only place a provider needs to manage an in-flight bid. The
 * dashboard and provider-profile pages only LIST bids and link here.
 */
import type { Address } from '@solana/kit';
import { useSelectedWalletAccount, useSignMessage, useSignTransactions } from '@solana/react';
import { accounts } from '@tender/tender-client';
import type { UiWalletAccount } from '@wallet-standard/react';
import {
  ArrowUpRightIcon,
  InfoIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { RevealGlow, UnlockField } from '@/components/motion/reveal-glow';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import { withdrawBid } from '@/lib/bids/withdraw-flow';
import {
  deriveEphemeralBidKeypair,
  deriveEphemeralBidWalletMessage,
} from '@/lib/crypto/derive-ephemeral-bid-wallet';
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
import { listBids } from '@/lib/solana/chain-reads';
import { rpc } from '@/lib/solana/client';
import { InlineMarkdown } from '@/components/ui/markdown';
import { cn } from '@/lib/utils';

export interface YourBidPanelProps {
  rfpId: string;
  rfpPda: string;
  bidderVisibility: 'public' | 'buyer_only';
  isBuyer: boolean;
  isOpenForBids: boolean;
  /** Server-side resolution for public mode. Absent in private mode. */
  existingBid?: {
    bidPda: string;
    submittedAt: string;
  } | null;
}

type Resolved =
  | { kind: 'no_bid' }
  | {
      kind: 'has_bid';
      bidPda: string;
      submittedAt?: string;
      ephemeralPubkey?: string;
    }
  | { kind: 'need_check' }
  | { kind: 'loading' };

export function YourBidPanel(props: YourBidPanelProps) {
  const [account] = useSelectedWalletAccount();

  if (props.isBuyer) return null;

  if (!account) {
    if (!props.isOpenForBids) return null;
    return (
      <Card className="border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Submit a sealed bid</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Connect a wallet from the top right to bid on this RFP.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <Connected account={account} {...props} />;
}

function Connected({
  account,
  rfpId,
  rfpPda,
  bidderVisibility,
  isOpenForBids,
  existingBid,
}: { account: UiWalletAccount } & YourBidPanelProps) {
  const signMessage = useSignMessage(account);
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const router = useRouter();

  // Initial resolution - public mode is server-driven; private mode reads
  // localStorage cache (no popups). On cache miss in private mode we drop to
  // need_check and surface a button.
  const [resolved, setResolved] = useState<Resolved>(() => {
    if (bidderVisibility === 'public') {
      if (existingBid) {
        return {
          kind: 'has_bid',
          bidPda: existingBid.bidPda,
          submittedAt: existingBid.submittedAt,
        };
      }
      return { kind: 'no_bid' };
    }
    return { kind: 'loading' };
  });

  // Private mode cache lookup runs after mount (localStorage isn't safe
  // during SSR/initial render).
  useEffect(() => {
    if (bidderVisibility !== 'buyer_only') return;
    let cancelled = false;
    try {
      const key = `tender:bid:${rfpPda}:${account.address}`;
      const cached = localStorage.getItem(key);
      if (cached) {
        const j = JSON.parse(cached) as {
          ephemeralPubkey?: string;
          bidPda?: string;
          submittedAt?: string;
        };
        if (j.ephemeralPubkey && j.bidPda) {
          if (!cancelled) {
            setResolved({
              kind: 'has_bid',
              bidPda: j.bidPda,
              ephemeralPubkey: j.ephemeralPubkey,
              submittedAt: j.submittedAt,
            });
          }
          return;
        }
      }
      if (!cancelled) setResolved({ kind: 'need_check' });
    } catch {
      if (!cancelled) setResolved({ kind: 'need_check' });
    }
    return () => {
      cancelled = true;
    };
  }, [bidderVisibility, rfpPda, account.address]);

  // ---- Cached crypto state across the session ------------------------------
  // X25519 provider keypair (used for ECIES decryption) - same for all RFPs.
  // Ephemeral signer keypair (used for TEE auth + withdraw signing in private
  // mode) - per-RFP. Both derive from a single wallet message-sign each.
  // biome-ignore lint/suspicious/noExplicitAny: keypair shape from helper
  const [cachedProviderKp, setCachedProviderKp] = useState<any | null>(null);
  const [cachedEphemeralKp, setCachedEphemeralKp] = useState<
    import('@solana/web3.js').Keypair | null
  >(null);

  /**
   * Derive (or return cached) ephemeral keypair for this RFP. Throws if the
   * derived pubkey doesn't match `expected` - guards against stale localStorage
   * cache or a wallet swap.
   */
  const ensureEphemeralKeypair = useCallback(
    async (expected?: string): Promise<import('@solana/web3.js').Keypair> => {
      if (cachedEphemeralKp) {
        if (expected && cachedEphemeralKp.publicKey.toBase58() !== expected) {
          throw new Error('Cached ephemeral pubkey does not match the expected one.');
        }
        return cachedEphemeralKp;
      }
      const seedMsg = deriveEphemeralBidWalletMessage(rfpPda);
      // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
      const seedSig = await (signMessage as any)({ message: seedMsg });
      const eph = await deriveEphemeralBidKeypair(seedSig.signature);
      if (expected && eph.publicKey.toBase58() !== expected) {
        throw new Error(
          'Derived ephemeral pubkey mismatch - your localStorage cache may be from a different wallet.',
        );
      }
      setCachedEphemeralKp(eph);
      return eph;
    },
    [cachedEphemeralKp, rfpPda, signMessage],
  );

  // ---- Private mode: derive ephemeral + query chain on demand --------------
  async function handleVerifyPrivate() {
    setResolved({ kind: 'loading' });
    try {
      const eph = await ensureEphemeralKeypair();
      const ephPubkey = eph.publicKey.toBase58();
      const matches = await listBids({
        rfpPda: rfpPda as Address,
        providerWallet: ephPubkey as Address,
      });
      if (matches.length === 0) {
        setResolved({ kind: 'no_bid' });
        return;
      }
      const found = matches[0]!;
      const submitted = new Date(Number(found.data.submittedAt) * 1000).toISOString();
      try {
        localStorage.setItem(
          `tender:bid:${rfpPda}:${account.address}`,
          JSON.stringify({
            ephemeralPubkey: ephPubkey,
            bidPda: found.address,
            submittedAt: submitted,
          }),
        );
      } catch {
        /* quota */
      }
      setResolved({
        kind: 'has_bid',
        bidPda: found.address,
        ephemeralPubkey: ephPubkey,
        submittedAt: submitted,
      });
    } catch (e) {
      toast.error('Verification failed', { description: friendlyBidError(e) });
      setResolved({ kind: 'need_check' });
    }
  }

  // ---- Reveal --------------------------------------------------------------
  // Two crypto identities:
  //  - ECIES (X25519): provider keypair derived from MAIN wallet sig. Same for
  //    public + private - the encrypted envelope is targeted at this pubkey.
  //  - TEE auth: keyed to the BID SIGNER. Public mode = main wallet; private
  //    mode = ephemeral wallet (PER's permission account is set up for the
  //    ephemeral, so a main-wallet token would be denied).
  const [revealing, setRevealing] = useState(false);
  const [plaintext, setPlaintext] = useState<SealedBidPlaintext | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const handleReveal = useCallback(
    async (bidPda: string, ephemeralPubkey?: string) => {
      setRevealing(true);
      setRevealError(null);
      try {
        // Resolve a "bid signer" - this is the wallet that signed the bid
        // and against which both TEE auth + X25519 derivation must align with
        // the submit-flow:
        //   - Public mode: main wallet (popup-signed)
        //   - Private mode: ephemeral keypair (signed locally, no popup)
        let bidSignerSign: (msg: Uint8Array) => Promise<Uint8Array>;
        let teeWallet: Address;

        if (bidderVisibility === 'buyer_only') {
          if (!ephemeralPubkey) throw new Error('Missing ephemeral pubkey for private reveal.');
          const eph = await ensureEphemeralKeypair(ephemeralPubkey);
          // biome-ignore lint/suspicious/noExplicitAny: noble subpath types vary
          const ed = (await import('@noble/curves/ed25519.js')) as any;
          const ed25519 = ed.ed25519 ?? ed.default?.ed25519 ?? ed;
          const seed32 = eph.secretKey.slice(0, 32);
          teeWallet = ephemeralPubkey as Address;
          bidSignerSign = async (msg) => new Uint8Array(ed25519.sign(msg, seed32));
        } else {
          teeWallet = account.address as Address;
          bidSignerSign = async (msg) => {
            // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
            const { signature: sig } = await (signMessage as any)({ message: msg });
            return sig;
          };
        }

        // 1. Provider X25519 keypair - derived from the BID SIGNER's sig over
        //    deriveProviderSeedMessage(). Must match submit-flow exactly: the
        //    envelope is encrypted to whoever signed the deriv message, and in
        //    private mode that's the ephemeral (so the X25519 is per-RFP). In
        //    public mode the bid signer == main wallet → X25519 is per-wallet.
        let kp = cachedProviderKp;
        if (!kp) {
          const providerSeedMsg = deriveProviderSeedMessage();
          const providerSig = await bidSignerSign(providerSeedMsg);
          kp = deriveProviderKeypair(providerSig);
          setCachedProviderKp(kp);
        }

        // 2. TEE auth challenge - also signed by the bid signer (PER permission
        //    is keyed to it). Cached per-(wallet, rpcUrl).
        const teeToken = await ensureTeeAuthToken(teeWallet, bidSignerSign);
        const erRpc = ephemeralRpc(teeToken);
        const raw = await fetchDelegatedAccountBytes(bidPda as Address, erRpc);
        if (!raw) {
          setRevealError(
            bidderVisibility === 'buyer_only'
              ? 'Bid not found on the ephemeral rollup. The ephemeral keypair may not match this bid.'
              : 'PER permission denied or account not found.',
          );
          return;
        }
        const decoded = accounts.getBidCommitDecoder().decode(raw);
        const providerEnvelope = decoded.providerEnvelope as Uint8Array;
        const json = new TextDecoder().decode(decryptBid(providerEnvelope, kp.x25519PrivateKey));
        const parsed = sealedBidPlaintextSchema.safeParse(JSON.parse(json));
        if (!parsed.success) {
          setRevealError('Plaintext failed schema validation.');
          return;
        }
        setPlaintext(parsed.data);
        toast.success('Bid decrypted', { description: bidPda.slice(0, 12) });
      } catch (e) {
        setRevealError((e as Error).message ?? 'Reveal failed');
        toast.error('Reveal failed', { description: friendlyBidError(e) });
      } finally {
        setRevealing(false);
      }
    },
    [account.address, cachedProviderKp, signMessage, bidderVisibility, ensureEphemeralKeypair],
  );

  function handleHide() {
    setPlaintext(null);
    setRevealError(null);
  }

  // ---- Withdraw - uniform interface across public + private ----------------
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawStage, setWithdrawStage] = useState<string | null>(null);

  async function handleWithdraw(bidPda: string, ephemeralPubkey?: string) {
    setWithdrawing(true);
    try {
      let ephemeralKeypair: import('@solana/web3.js').Keypair | undefined;
      let providerWallet: Address;
      if (bidderVisibility === 'buyer_only') {
        if (!ephemeralPubkey) throw new Error('Missing ephemeral pubkey for private withdraw');
        ephemeralKeypair = await ensureEphemeralKeypair(ephemeralPubkey);
        providerWallet = ephemeralPubkey as Address;
      } else {
        providerWallet = account.address as Address;
      }

      const result = await withdrawBid({
        bidPda: bidPda as Address,
        rfpPda: rfpPda as Address,
        providerWallet,
        // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
        signMessage: signMessage as any,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        rpc,
        ephemeralKeypair,
        onProgress: (s) => setWithdrawStage(s),
      });
      toast.success('Bid withdrawn', {
        description: `er ${result.txSignature.slice(0, 8)}…`,
        duration: 8000,
      });
      // Local state: collapse the panel to the no-bid CTA.
      setPlaintext(null);
      setResolved({ kind: 'no_bid' });
      // Private mode: keep ephemeralPubkey in cache so SweepEphemeralPanel
      // can still surface the rent refund. Drop bidPda only.
      if (bidderVisibility === 'buyer_only' && ephemeralPubkey) {
        try {
          localStorage.setItem(
            `tender:bid:${rfpPda}:${account.address}`,
            JSON.stringify({ ephemeralPubkey, withdrawnAt: new Date().toISOString() }),
          );
        } catch {
          /* ignore */
        }
      }
      // Public mode: server holds truth - refresh the RFP page so chain query
      // re-runs (bid is now closed, bid_count decremented).
      if (bidderVisibility === 'public') {
        router.refresh();
      }
    } catch (e) {
      toast.error('Withdraw failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setWithdrawing(false);
      setWithdrawStage(null);
    }
  }

  // -------------------------------------------------------------- render ----
  if (resolved.kind === 'loading') {
    return <SkeletonCard label="Checking your bidder identity…" />;
  }

  if (resolved.kind === 'need_check') {
    return (
      <Card className="border-dashed border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LockKeyholeIcon className="size-4 text-muted-foreground" />
            Check if you've bid here
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p className="text-muted-foreground">
            Private RFPs sign bids with a per-RFP ephemeral wallet that isn't visible from your main
            wallet's tx history. Verify on-chain with one popup.
          </p>
          {isOpenForBids && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Only one bid per main wallet per RFP - if you've already bid, the program will reject
              a duplicate. Verify first.
            </p>
          )}
        </CardContent>
        <CardFooter className="flex items-center justify-between gap-3 border-t border-border/40 pt-3">
          {isOpenForBids ? (
            <Link
              href={`/rfps/${rfpId}/bid`}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              or submit a new sealed bid →
            </Link>
          ) : (
            <span />
          )}
          <Button type="button" onClick={handleVerifyPrivate}>
            Check on-chain (1 popup)
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (resolved.kind === 'no_bid') {
    if (!isOpenForBids) {
      return (
        <Card className="border-border/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Bidding closed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No bids accepted - the bid window has closed or the RFP is past the open phase.
            </p>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-card via-card to-primary/5">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 -right-8 size-40 rounded-full bg-primary/15 blur-3xl"
        />
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4 text-primary" />
            Submit a sealed bid
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            Your bid is encrypted to the buyer's public key on the way in. Other providers see only
            a 32-byte hash. Contents stay sealed in the TEE-backed validator until the buyer awards.
          </p>
          <Link
            href={`/rfps/${rfpId}/bid`}
            className={cn(
              buttonVariants({ size: 'lg' }),
              'h-11 gap-2 rounded-full px-6 shadow-md shadow-primary/25',
            )}
          >
            Compose bid <ArrowUpRightIcon className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    );
  }

  // resolved.kind === 'has_bid'
  const bid = resolved;
  const revealed = plaintext != null;
  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-colors duration-700',
        revealed
          ? 'border-primary/40 bg-gradient-to-br from-card via-card to-primary/8'
          : 'border-primary/25 bg-gradient-to-br from-card via-card to-primary/5',
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
          Your bid on this RFP
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {bidderVisibility === 'buyer_only' && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-primary">
              <ShieldCheckIcon className="size-3" /> ephemeral signer
            </span>
          )}
          <StatusPill tone={revealed ? 'reveal' : 'sealed'}>
            {revealed ? 'decrypted in-memory' : 'sealed'}
          </StatusPill>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border/60 bg-card/40 p-3 backdrop-blur-sm">
          <DataField label="bid PDA" value={<HashLink hash={bid.bidPda} kind="account" />} />
          {bid.ephemeralPubkey && (
            <DataField
              label="bid signer (ephemeral)"
              value={<HashLink hash={bid.ephemeralPubkey} kind="account" />}
            />
          )}
          {bid.submittedAt && (
            <DataField label="submitted" mono={false} value={<LocalTime iso={bid.submittedAt} />} />
          )}
        </div>

        {revealError && !revealed && (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            {revealError}
          </p>
        )}

        {revealed && plaintext && (
          <RevealGlow active={revealed}>
            <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-card/60 p-4 shadow-sm shadow-primary/5">
              <UnlockField delay={0}>
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Price">
                    <span className="font-mono text-base font-semibold tabular-nums">
                      ${Number(plaintext.priceUsdc).toLocaleString()}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                        USDC
                      </span>
                    </span>
                  </Stat>
                  <Stat label="Timeline">
                    <span className="font-mono text-base font-semibold tabular-nums">
                      {plaintext.timelineDays}
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                        days
                      </span>
                    </span>
                  </Stat>
                </div>
              </UnlockField>
              <UnlockField delay={0.1}>
                <Stat label="Scope">
                  {/* Full markdown render — bid scope can be AI-drafted (or
                      user-typed markdown) and the buyer sees the same
                      formatted version on their side. */}
                  <InlineMarkdown source={plaintext.scope} className="flex flex-col gap-2" />
                </Stat>
              </UnlockField>
              <UnlockField delay={0.2}>
                <Stat label={`Milestones · ${plaintext.milestones.length}`}>
                  <ul className="flex flex-col gap-1 rounded-lg border border-dashed border-border/60 bg-card/40 p-2.5">
                    {plaintext.milestones.map((m, i) => (
                      <li
                        key={`${bid.bidPda}-${i}`}
                        className="flex items-baseline justify-between gap-3 text-xs"
                      >
                        <span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {i + 1}
                          </span>{' '}
                          {m.name}
                        </span>
                        <span className="font-mono tabular-nums">
                          ${Number(m.amountUsdc).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Stat>
              </UnlockField>
            </div>
          </RevealGlow>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Tooltip>
              <TooltipTrigger
                render={(props) => (
                  <button
                    {...props}
                    type="button"
                    aria-label="What does Reveal do?"
                    className="inline-flex cursor-help items-center text-muted-foreground/60 transition-colors hover:text-foreground"
                  >
                    <InfoIcon className="size-3" />
                  </button>
                )}
              />
              <TooltipContent className="max-w-[300px] text-[11px] leading-relaxed">
                First reveal pops a wallet popup to derive your X25519 key + TEE auth token.
                Subsequent reveals decrypt instantly using the cached key. Plaintext lives only in
                this browser tab - refresh and it re-seals.
              </TooltipContent>
            </Tooltip>
            One popup the first time, instant after.
          </div>
          <div className="flex items-center gap-2">
            {!revealed ? (
              <Button
                type="button"
                size="sm"
                disabled={revealing}
                onClick={() => handleReveal(bid.bidPda, bid.ephemeralPubkey)}
                className="h-8 gap-1.5 rounded-full px-4"
              >
                <KeyRoundIcon className="size-3.5" />
                {revealing ? 'Decrypting…' : 'Reveal'}
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleHide}
                className="h-8 rounded-full px-3 text-xs text-muted-foreground"
              >
                Hide
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={withdrawing || !isOpenForBids}
              title={
                !isOpenForBids ? 'Withdraw is only available while bidding is open.' : undefined
              }
              onClick={() => handleWithdraw(bid.bidPda, bid.ephemeralPubkey)}
              className="h-8 min-w-[6.5rem] rounded-full px-4"
            >
              {withdrawing ? humanizeStage(withdrawStage, 'Withdrawing') : 'Withdraw'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SkeletonCard({ label }: { label: string }) {
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
          One moment…
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
