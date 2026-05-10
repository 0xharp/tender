'use client';

import {
  type TendrAccount,
  useTendrAccount,
  useTendrSignMessage,
  useTendrSignTransactions,
} from '@/lib/wallet';
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
import { accounts } from '@tender/tender-client';

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
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { InlineMarkdown } from '@/components/ui/markdown';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
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
import { listBids } from '@/lib/solana/chain-reads';
import { rpc } from '@/lib/solana/client';
import { cn } from '@/lib/utils';
import { useKeychainContext } from '@/lib/wallet';

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
  const account = useTendrAccount();
  const keychain = useKeychainContext();
  const isHdBuyer = useIsHdBuyer(props.rfpPda, account?.address, keychain);

  // Server-resolved (public-buyer match) OR client-resolved (HD-buyer
  // for a private RFP). Either way, the buyer should never see the
  // bidder panel — they can't bid on their own RFP, and the "checking
  // my bid" spinner is misleading.
  if (props.isBuyer || isHdBuyer) return null;

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
}: { account: TendrAccount } & YourBidPanelProps) {
  const signMessage = useTendrSignMessage(account);
  const signTransactions = useTendrSignTransactions(account);
  const keychain = useKeychainContext();
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

  // v2 private-mode resolution. Three phases, ordered cheapest-first:
  //   1. localStorage HD-index cache (`tender:bidder-index:...`)
  //      written by bid-composer at submit time. Hit = derive ephemeral
  //      via keychain (silent if unlocked) + query chain for the bid.
  //      Cost: 1 RPC call.
  //   2. Cache miss + keychain available: call `findOwnBidForRfp` —
  //      one batched getMultipleAccounts across 32 deterministic bid
  //      PDAs. Silent if keychain is already unlocked (typical post
  //      SIWS pre-warm); otherwise triggers ONE master sign popup.
  //      A "no bid found" result is a valid resolution (→ no_bid;
  //      surfaces the "Submit a sealed bid" UI), NOT an error.
  //      Cost: ~50-150ms.
  //   3. No keychain handle (mid-render disconnect) or sign rejected:
  //      surface the manual "Check on chain" CTA as a fallback.
  useEffect(() => {
    if (bidderVisibility !== 'buyer_only') return;
    let cancelled = false;

    void (async () => {
      const indexCacheKey = `tender:bidder-index:${rfpPda}:${account.address}`;
      const metaCacheKey = `tender:bid:${rfpPda}:${account.address}`;

      // Phase 1a: full-metadata cache (ephemeralPubkey + bidPda + submittedAt).
      // Written by bid-composer on submit and by handleVerifyPrivate /
      // findOwnBidForRfp recoveries. Lets us render without any wallet
      // popup — we only need the master seed when the user actually
      // takes an action (reveal/withdraw), which derives lazily.
      try {
        const rawMeta = localStorage.getItem(metaCacheKey);
        if (rawMeta) {
          const parsed = JSON.parse(rawMeta) as {
            ephemeralPubkey?: string;
            bidPda?: string;
            submittedAt?: string;
            withdrawnAt?: string;
          };
          // The withdraw path leaves a stub `{ephemeralPubkey, withdrawnAt}`
          // for the sweep panel — no bidPda means no bid to surface.
          if (parsed.bidPda && parsed.ephemeralPubkey) {
            setResolved({
              kind: 'has_bid',
              bidPda: parsed.bidPda,
              ephemeralPubkey: parsed.ephemeralPubkey,
              submittedAt: parsed.submittedAt,
            });
            return;
          }
        }
      } catch {
        /* JSON parse / localStorage failure — fall through */
      }

      let cachedIdx: number | null = null;
      try {
        const raw = localStorage.getItem(indexCacheKey);
        if (raw !== null) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) cachedIdx = parsed;
        }
      } catch {
        /* localStorage disabled — fall through */
      }

      // Phase 1b: index-only cache. Derive ephemeral (needs master sign)
      // + chain-check the bid. Triggered when bid-composer wrote the
      // index but the metadata cache was cleared (or this device
      // received the index from DiscoverPrivateBids enumeration which
      // doesn't currently write metadata — see TODO there).
      if (cachedIdx !== null && keychain) {
        try {
          const eph = await keychain.bidderEphemeral(cachedIdx);
          const ephPubkey = eph.publicKey.toBase58();
          const matches = await listBids({
            rfpPda: rfpPda as Address,
            providerWallet: ephPubkey as Address,
          });
          const found = matches[0];
          if (cancelled) return;
          if (found) {
            const submitted = new Date(Number(found.data.submittedAt) * 1000).toISOString();
            // Upgrade the cache: write the full metadata so the next
            // visit hits Phase 1a and skips the sign entirely.
            try {
              localStorage.setItem(
                metaCacheKey,
                JSON.stringify({
                  ephemeralPubkey: ephPubkey,
                  bidPda: String(found.address),
                  submittedAt: submitted,
                }),
              );
            } catch {
              /* quota — non-fatal */
            }
            setResolved({
              kind: 'has_bid',
              bidPda: String(found.address),
              ephemeralPubkey: ephPubkey,
              submittedAt: submitted,
            });
          } else {
            // Index was allocated but bid never landed (abandoned
            // submission). Fall through to enumerate so we don't get
            // stuck on a stale cache.
            cachedIdx = null;
          }
          if (cachedIdx !== null) return;
        } catch {
          /* derivation failed; fall through */
        }
      }

      // Phase 2: resolve via the keychain. If it's already unlocked
      // (typical after the SIWS pre-warm), this is silent. If it's
      // locked but a keychain handle exists, this triggers ONE master
      // sign popup — user is on a private-bidder RFP detail page, so
      // they're clearly engaged and a popup is acceptable. Either way
      // we use `findOwnBidForRfp` (one batched getMultipleAccounts
      // over 32 deterministic bid PDAs) instead of the global
      // `enumerateOwnBids` (32 getProgramAccounts memcmp scans).
      // Typically ~50-150ms vs ~600ms.
      //
      // Important: a "no bid found" result is a valid resolution
      // (user hasn't bid yet — surface the "Submit a sealed bid" UI).
      // Only fall through to need_check if the keychain itself is
      // unavailable or the user dismissed the sign.
      if (keychain) {
        try {
          const masterSeed = await keychain.getMasterSeed();
          const { findOwnBidForRfp } = await import('@/lib/keychain/enumerate');
          const hit = await findOwnBidForRfp(masterSeed, rfpPda as Address);
          if (cancelled) return;
          if (hit) {
            const submitted = new Date(Number(hit.bid.data.submittedAt) * 1000).toISOString();
            try {
              localStorage.setItem(indexCacheKey, String(hit.index));
              // Also seed full metadata so next hard refresh skips
              // the master sign entirely (Phase 1a hits).
              localStorage.setItem(
                metaCacheKey,
                JSON.stringify({
                  ephemeralPubkey: hit.ephemeralPubkey,
                  bidPda: String(hit.bid.address),
                  submittedAt: submitted,
                }),
              );
            } catch {
              /* quota — non-fatal */
            }
            setResolved({
              kind: 'has_bid',
              bidPda: String(hit.bid.address),
              ephemeralPubkey: hit.ephemeralPubkey,
              submittedAt: submitted,
            });
            return;
          }
          setResolved({ kind: 'no_bid' });
          return;
        } catch {
          /* sign rejected / lookup failed — fall through to manual CTA */
        }
      }

      // Phase 3: no keychain or master sign rejected. Surface the
      // manual "Check on-chain" CTA. Clicking it re-runs the same
      // findOwnBidForRfp via handleVerifyPrivate.
      if (!cancelled) setResolved({ kind: 'need_check' });
    })();

    return () => {
      cancelled = true;
    };
  }, [bidderVisibility, rfpPda, account.address, keychain?.isUnlocked, keychain]);

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
   * Derive (or return cached) ephemeral keypair for this RFP via the
   * v2 HD keychain. Resolution order:
   *   1. In-memory cache (no work).
   *   2. localStorage `tender:bidder-index:<rfpPda>:<wallet>` — written
   *      at bid submit time. Hit = derive instantly via keychain.
   *   3. On-chain enumeration — fresh device or cleared storage.
   *      Scans HD bidder ephemerals 0..63 to find the one whose bid
   *      lives on THIS RFP. Caches the index for next time.
   *   4. Throws if no bid found under this main wallet's keychain.
   *
   * `expected` guards against stale state (wallet swap, etc).
   */
  const ensureEphemeralKeypair = useCallback(
    async (expected?: string): Promise<import('@solana/web3.js').Keypair> => {
      if (cachedEphemeralKp) {
        if (expected && cachedEphemeralKp.publicKey.toBase58() !== expected) {
          throw new Error('Cached ephemeral pubkey does not match the expected one.');
        }
        return cachedEphemeralKp;
      }
      if (!keychain) {
        throw new Error('Keychain not unlocked. Reconnect your wallet and try again.');
      }
      const indexCacheKey = `tender:bidder-index:${rfpPda}:${account.address}`;
      let idx: number | null = null;
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem(indexCacheKey);
        if (raw !== null) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) idx = parsed;
        }
      }
      if (idx === null) {
        // Fresh device / cleared storage — scan HD bidder ephemerals
        // for one with a bid on this RFP. ~600ms over a good RPC.
        const masterSeed = await keychain.getMasterSeed();
        const { enumerateOwnBids } = await import('@/lib/keychain/enumerate');
        const hits = await enumerateOwnBids(masterSeed);
        const hit = hits.find((h) => String(h.bid.data.rfp) === rfpPda);
        if (!hit) {
          throw new Error('No bid found for this RFP under your HD keychain');
        }
        idx = hit.index;
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(indexCacheKey, String(idx));
        }
      }
      const eph = await keychain.bidderEphemeral(idx);
      if (expected && eph.publicKey.toBase58() !== expected) {
        throw new Error(
          'Derived ephemeral pubkey mismatch — your HD index cache may be stale or from a different wallet.',
        );
      }
      setCachedEphemeralKp(eph);
      return eph;
    },
    [cachedEphemeralKp, rfpPda, account.address, keychain],
  );

  // ---- Private mode: derive ephemeral + query chain on demand --------------
  // Uses `findOwnBidForRfp` directly (one batched getMultipleAccounts call
  // across 32 deterministic bid PDAs). Distinguishes three outcomes:
  //   - hit found       → has_bid + seed cache
  //   - confirmed empty → no_bid (NOT an error — user just hasn't bid yet,
  //                       surfaces the "Submit a sealed bid" UI)
  //   - sign / RPC fail → revert to need_check + toast
  async function handleVerifyPrivate() {
    if (!keychain) {
      toast.error('Keychain unavailable — reconnect your wallet and try again.');
      return;
    }
    setResolved({ kind: 'loading' });
    try {
      const masterSeed = await keychain.getMasterSeed();
      const { findOwnBidForRfp } = await import('@/lib/keychain/enumerate');
      const hit = await findOwnBidForRfp(masterSeed, rfpPda as Address);
      if (!hit) {
        setResolved({ kind: 'no_bid' });
        return;
      }
      const submitted = new Date(Number(hit.bid.data.submittedAt) * 1000).toISOString();
      try {
        localStorage.setItem(`tender:bidder-index:${rfpPda}:${account.address}`, String(hit.index));
        localStorage.setItem(
          `tender:bid:${rfpPda}:${account.address}`,
          JSON.stringify({
            ephemeralPubkey: hit.ephemeralPubkey,
            bidPda: String(hit.bid.address),
            submittedAt: submitted,
          }),
        );
      } catch {
        /* quota — non-fatal */
      }
      setResolved({
        kind: 'has_bid',
        bidPda: String(hit.bid.address),
        ephemeralPubkey: hit.ephemeralPubkey,
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
        description: <TxToastDescription hash={result.txSignature} prefix="withdraw tx" />,
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

/**
 * Detect whether the connected main wallet owns this RFP via an HD
 * buyer ephemeral. Mirrors the marketplace grid's resolution order:
 *   1. localStorage `tender:buyer-index:<rfpPda>:<wallet>` (sync, no RPC).
 *      Seeded by create-flow at create-time + by marketplace grid +
 *      DiscoverPrivateRfps when they enumerate.
 *   2. If the keychain is already unlocked this session, silently call
 *      `enumerateOwnedRfps` and look for a hit on this RFP. Seeds the
 *      cache for next visit.
 * We deliberately do NOT auto-prompt master sign here — too aggressive
 * for an RFP detail page someone might just be browsing.
 */
function useIsHdBuyer(
  rfpPda: string,
  walletAddress: string | undefined,
  keychain: ReturnType<typeof useKeychainContext>,
): boolean {
  const [isHdBuyer, setIsHdBuyer] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !walletAddress) return false;
    const key = `tender:buyer-index:${rfpPda}:${walletAddress}`;
    return window.localStorage.getItem(key) !== null;
  });

  useEffect(() => {
    if (isHdBuyer) return;
    if (typeof window === 'undefined' || !walletAddress) return;
    // Re-check synchronously in case another surface populated the cache
    // between mount and this effect (e.g. marketplace grid's enumerate
    // completing while we render).
    const key = `tender:buyer-index:${rfpPda}:${walletAddress}`;
    if (window.localStorage.getItem(key) !== null) {
      setIsHdBuyer(true);
      return;
    }
    if (!keychain?.isUnlocked) return;
    let cancelled = false;
    void (async () => {
      try {
        const masterSeed = await keychain.getMasterSeed();
        const { enumerateOwnedRfps } = await import('@/lib/keychain/enumerate');
        const hits = await enumerateOwnedRfps(masterSeed);
        if (cancelled) return;
        const hit = hits.find((h) => String(h.rfp.address) === rfpPda);
        if (!hit) return;
        try {
          window.localStorage.setItem(key, String(hit.index));
        } catch {
          /* quota — non-fatal */
        }
        setIsHdBuyer(true);
      } catch {
        /* enumerate failed — leave isHdBuyer false */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rfpPda, walletAddress, keychain, isHdBuyer]);

  return isHdBuyer;
}
