'use client';

import {
  type TendrAccount,
  triggerActivityRefresh,
  useKeychainContext,
  useTendrAccount,
  useTendrSignMessage,
  useTendrSignTransactions,
} from '@/lib/wallet';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Keypair } from '@solana/web3.js';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { SparklesIcon } from 'lucide-react';

import { AiDraftModal } from '@/components/ai/ai-draft-modal';
import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarkdownEditor } from '@/components/ui/markdown-editor';
import { Textarea } from '@/components/ui/textarea';
import { isAiAvailable } from '@/lib/ai';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import type { BidderVisibility } from '@/lib/bids/schema';
import { type BidFormValues, bidFormSchema } from '@/lib/bids/schema';
import {
  type BidSubmitStage,
  type PayoutMode,
  type SubmitBidResult,
  submitBid,
} from '@/lib/bids/submit-flow';
import { scrollToFirstError } from '@/lib/forms/scroll-to-error';
import { prefetchCloak } from '@/lib/sdks/cloak';
import { useSnsName } from '@/lib/sns/hooks';
import { rpc, stripSolanaClientHeaderMiddleware } from '@/lib/solana/client';
import { cn } from '@/lib/utils';
import type { Address } from '@solana/kit';

/** Cloak's mock USDC mint on devnet — required for the v2 private-funding
 *  flow (Cloak's shielded-pool transfer only supports this mint on devnet;
 *  real Circle USDC is mainnet-only on Cloak). One-line swap to Circle
 *  mainnet (`EPjFWdd5…`) for the production mainnet deploy.
 *  Faucet: https://devnet.cloak.ag/privacy/faucet */
const DEVNET_MOCK_USDC_MINT = '61ro7AExqfk4dZYoCyRzTahahCC2TdUUZ4M5epMPunJf' as const;

/** Local-only stage values the bid-composer surfaces BEFORE submitBid takes
 *  over its own onProgress reporting. Lets the spinner stay informative
 *  while we're awaiting wallet popups for seed + binding sigs (which can
 *  hang in some wallets) and during the dynamic imports / RPC balance check
 *  inside submitBid's privacy-mode preamble. */
type ComposerLocalStage = 'awaiting_seed_sig' | 'checking_funds';
type ComposerStage = BidSubmitStage | ComposerLocalStage;

const STAGE_LABEL: Record<ComposerStage, string> = {
  awaiting_seed_sig: 'Approve the ephemeral-wallet seed signature…',
  checking_funds: 'Checking privacy-wallet balance on devnet…',
  deriving_provider_key: 'Approve the derive-key signature in your wallet…',
  deriving_bid_seed: 'Approve the private bid seed signature…',
  funding_ephemeral_wallet: 'Funding privacy wallet via Cloak shielded pool…',
  encrypting: 'Encrypting bid to buyer + provider pubkeys…',
  authenticating_er: 'Authenticating with the MagicBlock TEE rollup…',
  building_txs: 'Building all transactions for batched signing…',
  awaiting_signature: 'Approve all transactions in your wallet (single popup)…',
  submitting_init: 'Submitting init + delegation transaction…',
  awaiting_delegation: 'Waiting for the bid to land on the private rollup…',
  writing_chunks: 'Writing encrypted bid chunks to the rollup…',
  finalizing: 'Sealing the bid (sha256 verification)…',
  saving_metadata: 'Saving bid index entry…',
};

// Rough per-stage time estimates in seconds. Drives the "~Xs left"
// hint + the progress bar fill on the BidComposerProgress component.
// Cloak shielded funding + the ER auth/delegation/chunk-write loop are
// the slow chunks; wallet popups are also amortized in here so the bar
// doesn't visually freeze while we wait on the user. Numbers tuned from
// observed devnet timings — fine to be off by ±30%, the bar is a "this
// is normal, not stuck" signal, not a real ETA.
const COMPOSER_STAGE_SECONDS: Record<ComposerStage, number> = {
  awaiting_seed_sig: 3,
  deriving_provider_key: 1,
  deriving_bid_seed: 1,
  checking_funds: 1,
  funding_ephemeral_wallet: 18,
  encrypting: 1,
  authenticating_er: 3,
  building_txs: 1,
  awaiting_signature: 3,
  submitting_init: 5,
  awaiting_delegation: 8,
  writing_chunks: 5,
  finalizing: 3,
  saving_metadata: 1,
};

// Linear order the stages fire in. Some only fire in private bidder
// mode (Cloak funding, ER chunk writes); in public mode the bar
// "skips" past them to the next live stage. That's intentional — the
// bar should always advance, never reverse, even when whole sections
// of the flow are short-circuited.
const COMPOSER_STAGE_ORDER: ComposerStage[] = [
  'awaiting_seed_sig',
  'deriving_provider_key',
  'deriving_bid_seed',
  'checking_funds',
  'funding_ephemeral_wallet',
  'encrypting',
  'authenticating_er',
  'building_txs',
  'awaiting_signature',
  'submitting_init',
  'awaiting_delegation',
  'writing_chunks',
  'finalizing',
  'saving_metadata',
];

const COMPOSER_TOTAL_SECONDS = COMPOSER_STAGE_ORDER.reduce(
  (acc, s) => acc + COMPOSER_STAGE_SECONDS[s],
  0,
);

/**
 * Step-counter + progress-bar UX mirroring the create-RFP flow's
 * `PrivateCreateProgress`. Replaces the single-line stage label so the
 * user can see "this is step 6 of 15, ~38s left" instead of one
 * pulsing dot that never moves during the 18-second Cloak shielded
 * transfer. Without the bar, the long Cloak phase looks like a hang.
 */
function BidComposerProgress({ stage }: { stage: ComposerStage }) {
  const idx = COMPOSER_STAGE_ORDER.indexOf(stage);
  const elapsedSecs = COMPOSER_STAGE_ORDER.slice(0, Math.max(idx, 0)).reduce(
    (acc, s) => acc + COMPOSER_STAGE_SECONDS[s],
    0,
  );
  const remainingSecs = Math.max(0, COMPOSER_TOTAL_SECONDS - elapsedSecs);
  const pct = Math.min(100, Math.round((elapsedSecs / COMPOSER_TOTAL_SECONDS) * 100));
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-primary/20 bg-primary/[0.03] p-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 text-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
          {STAGE_LABEL[stage]}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          step {Math.min(idx + 1, COMPOSER_STAGE_ORDER.length)} of {COMPOSER_STAGE_ORDER.length} · ~
          {remainingSecs}s left
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className="h-full bg-primary transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export interface BidComposerProps {
  rfpId: string;
  rfpPda: string;
  rfpNonceHex: string;
  bidderVisibility: BidderVisibility;
  buyerEncryptionPubkeyHex: string;
  /** Whether the buyer set a sealed reserve at create time. Drives a UI
   *  banner; the value itself is hidden from providers by design. */
  hasReserve?: boolean;
  /** Platform fee in basis points (e.g. 250 = 2.5%). Sourced from on-chain
   *  `rfp.fee_bps` so it's locked per-RFP. Provider sees this transparently
   *  to price their bid net of fee. */
  feeBps: number;
  /** Optional RFP context for the "Draft starting bid with AI" button.
   *  When the AI sidecar URL isn't configured the button hides itself;
   *  when scope is missing the button still renders but the AI has
   *  less to work with. */
  rfpTitle?: string;
  rfpScope?: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function BidComposer(props: BidComposerProps) {
  const account = useTendrAccount();

  if (!account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect a wallet to submit a bid</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Use the wallet picker in the top nav. The bid composer will appear once a wallet is
            selected.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <ConnectedComposer account={account} {...props} />;
}

function BidCharCounter({
  value,
  min,
  max,
  hint,
}: { value: string; min: number; max: number; hint?: string }) {
  const len = value.length;
  const tooShort = len < min;
  const tooLong = len > max;
  return (
    <p
      className={
        tooShort || tooLong
          ? 'text-[10px] text-amber-600 dark:text-amber-400'
          : 'text-[10px] text-muted-foreground'
      }
    >
      {len} / {max} characters{hint ? ` · ${hint}` : ''}
      {tooShort && ` · ${min - len} more required`}
      {tooLong && ` · ${len - max} over the limit`}
    </p>
  );
}

/** Initial milestone count when the composer first mounts. The provider can
 *  freely add/remove milestones (1–8) - this is just a starting point that
 *  most procurement bids tend to gravitate toward. */
const DEFAULT_MILESTONE_COUNT = 1;

function ConnectedComposer({
  account,
  rfpId,
  rfpPda,
  rfpNonceHex,
  bidderVisibility,
  buyerEncryptionPubkeyHex,
  hasReserve,
  feeBps,
  rfpTitle,
  rfpScope,
}: { account: TendrAccount } & BidComposerProps) {
  const feePct = (feeBps / 100).toFixed(feeBps % 100 === 0 ? 1 : 2);
  const netRatio = (10_000 - feeBps) / 10_000;
  const formatNet = (gross: string): string => {
    const n = Number(gross);
    if (!Number.isFinite(n) || n <= 0) return '0';
    return (n * netRatio).toFixed(2);
  };
  const signTransactions = useTendrSignTransactions(account);
  const signMessage = useTendrSignMessage(account);
  const [stage, setStage] = useState<ComposerStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SubmitBidResult | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  // Resolve `.tendr.sol` for the connected main wallet so the
  // post-success "Your provider profile" link reads as the human handle
  // when one is claimed (the /providers/[wallet] route accepts both
  // pubkey and `.sol` slug — `resolveWalletParam` normalizes either).
  // Falls back to raw address when no SNS handle is set.
  const profileSlug = useSnsName(account.address as Address) ?? account.address;
  // Privacy mode is determined by the RFP's bidder_visibility setting (set by
  // the buyer at create time). Provider doesn't choose it - they get the mode
  // the buyer picked.
  const isPrivateMode = bidderVisibility === 'buyer_only';
  // v2 HD-keychain bidder ephemeral. Replaces the v1 per-RFP signed-
  // message derivation: now the ephemeral comes from
  // `keychain.bidderEphemeral(index)` where `index` is allocated once
  // per RFP via on-chain enumeration (or read from localStorage on
  // subsequent visits). Benefits:
  //   - Same master sign covers buyer + bidder + fund + refund + payout
  //     surfaces across the whole session.
  //   - DiscoverPrivateBids can enumerate ALL of the user's private
  //     bids by scanning HD indices 0..63 — without HD this would
  //     require remembering every RFP they bid on.
  // Trade-off: a fresh device needs to (a) sign the master message
  // once, (b) enumerate to find the index allocated for THIS RFP if
  // localStorage is cold. Both are bounded; UX-equivalent to the v1
  // per-RFP signMessage cost.
  const [bidderIndex, setBidderIndex] = useState<number | null>(null);
  const [ephemeralKeypair, setEphemeralKeypair] = useState<Keypair | null>(null);
  const keychain = useKeychainContext();
  // Cache the binding signature across submit retries AND page reloads. Why
  // the cache exists: every fresh signMessage call without it pops the wallet
  // TWICE (seed + binding). On a retry after a failed first submit + a Cloak
  // funding flow (2-3 more popups), some wallets (Nightly observed) hang
  // their signMessage queue and the next popup never surfaces — leaving the
  // submit button stuck on "Submitting…" with no UI. Why sessionStorage:
  // component state alone dies on reload, so a user who reloads mid-flow has
  // to redo both popups; sessionStorage scoped to (rfpPda, wallet) survives
  // reloads but doesn't persist past tab close (no long-term local secrets).
  // v2 claim-based: no binding-signature cache anymore — the bid no
  // longer needs a main-wallet binding sig at submit time. The optional
  // post-completion `attest_win` claim re-signs live from the main
  // wallet at click time, so there's nothing to persist here.
  //
  // We DO still cache the per-RFP HD index in localStorage so retries /
  // your-bid-panel / sweep all see the same index. The ephemeral
  // keypair itself is recomputed from (master seed, index) on demand
  // and never persisted.
  const indexCacheKey = `tender:bidder-index:${rfpPda}:${account.address}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keychain is a stable singleton from KeychainProvider; depending on isUnlocked specifically retriggers when another surface unlocks
  useEffect(() => {
    if (!isPrivateMode) return;
    if (typeof window === 'undefined') return;
    try {
      const idxRaw = window.localStorage.getItem(indexCacheKey);
      if (idxRaw !== null) {
        const idx = Number(idxRaw);
        if (Number.isFinite(idx)) {
          setBidderIndex(idx);
          if (keychain?.isUnlocked) {
            void keychain.bidderEphemeral(idx).then(setEphemeralKeypair);
          }
        }
      }
    } catch {
      /* corrupt cache — ignore, user will re-allocate */
    }
  }, [indexCacheKey, isPrivateMode, keychain?.isUnlocked]);
  void prefetchCloak; // kept for future Cloak-shielded funding integration

  // Empty defaults - every field is the provider's intentional input. The
  // milestone array starts with N empty rows so they have somewhere to type
  // (an empty array would hide the milestone form entirely).
  const form = useForm<BidFormValues>({
    resolver: zodResolver(bidFormSchema),
    defaultValues: {
      price_usdc: '',
      scope: '',
      // biome-ignore lint/suspicious/noExplicitAny: numeric field starts blank
      timeline_days: undefined as any,
      milestones: Array.from({ length: DEFAULT_MILESTONE_COUNT }, (_, _i) => ({
        name: '',
        description: '',
        amount_usdc: '',
        // biome-ignore lint/suspicious/noExplicitAny: numeric blank
        duration_days: undefined as any,
        success_criteria: '',
      })),
      payout_address: account.address,
      notes: '',
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'milestones',
  });

  async function onSubmit(values: BidFormValues) {
    setSubmitting(true);
    setStage(null);
    try {
      let payoutMode: PayoutMode;

      if (!isPrivateMode) {
        payoutMode = { kind: 'main' };
      } else {
        // Private mode prep — v2 HD-keychain path.
        if (!keychain) {
          throw new Error('Wallet not unlocked. Reconnect and try again.');
        }
        // No binding-sig acquisition at submit time anymore — see the
        // useEffect above for the rationale (attest_win re-signs live).

        // 1. Get the HD index for this RFP. Allocate a fresh one on
        // first bid; reuse the cached one on retries / re-renders so
        // every retry produces the same ephemeral pubkey + bid PDA.
        let eph: Keypair;
        if (ephemeralKeypair) {
          eph = ephemeralKeypair;
        } else {
          setStage('awaiting_seed_sig');
          const masterSeed = await keychain.getMasterSeed();
          let idx = bidderIndex;
          if (idx === null) {
            const { nextBidderIndex } = await import('@/lib/keychain/enumerate');
            idx = await nextBidderIndex(masterSeed);
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(indexCacheKey, String(idx));
            }
            setBidderIndex(idx);
          }
          eph = await keychain.bidderEphemeral(idx);
          setEphemeralKeypair(eph);
        }

        // v2 claim-based: no binding-signature popup at submit time.
        // The provider's main wallet leaves NO on-chain footprint at all
        // — not in any field, not in any encrypted envelope (symmetric
        // with anonymous-buyer mode where rfp.buyer is also the eph and
        // the main wallet never appears anywhere on chain). The optional
        // post-completion `attest_win` claim re-signs the binding message
        // live from the main wallet at click time, so we don't need to
        // produce or cache a signature here.

        // Submit-flow will now do the on-chain balance
        // check (an RPC call that can take several seconds on cold devnet),
        // load the noble crypto module, and start its own onProgress reporting.
        // Surface a stage so the spinner isn't context-free during that gap.
        setStage('checking_funds');

        // v2 — auto-fund the bidder ephemeral via Cloak if it's short of
        // SOL. Replaces the manual "Fund via Cloak" button on the old
        // EphemeralFundingPanel. Mirrors the create-RFP private path's
        // structure: deposit 0.08 SOL (covers bid PDA rent + PER infra +
        // tx fees + headroom for big envelopes). Skipped silently if the
        // ephemeral already has enough — supports retries without an
        // extra deposit.
        const REQUIRED_LAMPORTS = 80_000_000n; // 0.08 SOL
        const REQUIRED_FLOOR_LAMPORTS = 40_000_000n; // top up when below 0.04 SOL
        const balance = await rpc.getBalance(eph.publicKey.toBase58() as Address).send();
        if (BigInt(balance.value) < REQUIRED_FLOOR_LAMPORTS) {
          setStage('funding_ephemeral_wallet');
          const [{ fundEphemeralWallet }, { Connection, PublicKey }] = await Promise.all([
            import('@/lib/sdks/cloak'),
            import('@solana/web3.js'),
          ]);
          const { buildCloakSignTransactionAdapter } = await import('@/lib/wallet');
          const cloakSignTx = await buildCloakSignTransactionAdapter(signTransactions);
          await fundEphemeralWallet({
            walletPublicKey: new PublicKey(account.address),
            signTransaction: cloakSignTx,
            signMessage: async (msg: Uint8Array) => {
              const { signature } = await signMessage({ message: msg });
              return signature;
            },
            ephemeralPubkey: eph.publicKey,
            depositLamports: REQUIRED_LAMPORTS,
            connection: new Connection(
              process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
              'confirmed',
            ),
          });
        }

        payoutMode = {
          kind: 'ephemeral',
          ephemeralKeypair: eph,
        };
      }

      const result = await submitBid({
        rfpId,
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        rfpPda: rfpPda as any,
        rfpNonce: hexToBytes(rfpNonceHex),
        bidderVisibility,
        buyerEncryptionPubkeyHex,
        values,
        // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
        providerWallet: account.address as any,
        payoutMint: DEVNET_MOCK_USDC_MINT as Address,
        payoutMode,
        // biome-ignore lint/suspicious/noExplicitAny: kit signer narrowing at hook call site
        signMessage: signMessage as any,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        rpc,
        onProgress: setStage,
      });
      setSuccess(result);
      // Bubble the new bid into the central activity feed so the
      // provider profile / your-bids list / wallet popover badge
      // reflect it without waiting for tab-focus or a manual refresh.
      triggerActivityRefresh();
      // Cache the (rfp → ephemeral) mapping locally so the next page load can
      // surface the existing bid without forcing the user through another wallet
      // popup. Cross-device recovery requires the click-to-derive button on the
      // RFP page (PrivateBidIndicator).
      if (isPrivateMode && payoutMode.kind === 'ephemeral' && typeof window !== 'undefined') {
        try {
          localStorage.setItem(
            `tender:bid:${rfpPda}:${account.address}`,
            JSON.stringify({
              ephemeralPubkey: payoutMode.ephemeralKeypair.publicKey.toBase58(),
              bidPda: result.bidPda,
              submittedAt: new Date().toISOString(),
            }),
          );
        } catch {
          /* localStorage quota - non-fatal */
        }
      }
      toast.success('Sealed bid committed', {
        description: <TxToastDescription hash={result.finalizeTxSignature} prefix="Finalize tx" />,
        duration: 8000,
      });
    } catch (e) {
      toast.error('Bid commit failed', {
        description: friendlyBidError(e),
        duration: 12000,
      });
    } finally {
      setSubmitting(false);
      setStage(null);
    }
  }

  if (success) {
    return (
      <Card className="relative overflow-hidden border-primary/30 bg-gradient-to-br from-card via-card to-primary/5">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-12 -right-12 size-44 rounded-full bg-primary/15 blur-3xl"
        />
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="text-base">Sealed bid committed</CardTitle>
          <StatusPill tone="sealed">on-chain</StatusPill>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Your bid is encrypted to the buyer&rsquo;s pubkey and committed to devnet. Only the
            buyer can decrypt your proposal at the reveal window.
          </p>
          <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border/60 bg-card/40 p-4 backdrop-blur-sm">
            <DataField label="bid PDA" value={<HashLink hash={success.bidPda} kind="account" />} />
            <DataField
              label="init tx"
              value={<HashLink hash={success.initTxSignature} kind="tx" />}
            />
            <DataField
              label="finalize tx"
              value={<HashLink hash={success.finalizeTxSignature} kind="tx" />}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/rfps/${rfpPda}`}
              className="inline-flex h-9 items-center justify-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-md shadow-primary/25 transition-colors hover:bg-primary/90"
            >
              ← Back to RFP
            </Link>
            <Link
              href={`/providers/${profileSlug}`}
              className="inline-flex h-9 items-center justify-center rounded-full border border-border bg-card/60 px-4 text-sm font-medium transition-colors hover:bg-card"
            >
              Your provider profile
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit, scrollToFirstError)}
      className="flex flex-col gap-6"
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sealed bid</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <AboutYourBid isPrivate={isPrivateMode} mainWallet={account.address} />

          {hasReserve && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
              <p className="font-medium text-amber-700 dark:text-amber-300">
                This RFP has a sealed reserve price.
              </p>
              <p className="mt-1 text-muted-foreground">
                The buyer committed on-chain to a maximum acceptable price. Bids above that
                threshold will be rejected by the program at award time. The value isn't shown to
                providers - by design, so it doesn't anchor your bid. Bid your honest number.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="price_usdc">Bid price (USDC)</Label>
              <Input
                id="price_usdc"
                type="text"
                inputMode="decimal"
                {...form.register('price_usdc')}
              />
              <p className="text-[10px] text-muted-foreground">
                Quote gross. After the {feePct}% platform fee (locked per-RFP at create time),
                you'll receive ~$
                {Number(formatNet(form.watch('price_usdc') ?? '0')).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}{' '}
                across all milestones.
              </p>
              {form.formState.errors.price_usdc && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.price_usdc.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="timeline_days">Timeline (days)</Label>
              <Input
                id="timeline_days"
                type="number"
                min={1}
                max={365}
                {...form.register('timeline_days', { valueAsNumber: true })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor="scope">Scope</Label>
              {/* "Draft starting bid" only shows when both the AI sidecar
                  is configured AND we have an RFP scope to feed it.
                  Without scope context the AI has nothing to anchor on. */}
              {isAiAvailable() && rfpScope && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1.5 px-2 py-1 text-xs text-primary hover:bg-primary/10"
                  onClick={() => setAiOpen(true)}
                >
                  <SparklesIcon className="size-3.5" />
                  Start drafting bid with QVAC Private AI
                </Button>
              )}
            </div>
            {/* MarkdownEditor for the bid scope. Same reasoning as the RFP
                create form: AI-drafted bids arrive as markdown and the
                buyer-side render (winning-bid-panel + drawer) renders it
                as markdown. RHF.register doesn't compose with the editor's
                custom value/onChange API, so we wire it via watch + setValue. */}
            <MarkdownEditor
              id="scope"
              rows={5}
              placeholder="What you'll deliver, your approach, exclusions, assumptions. Markdown supported."
              value={form.watch('scope') ?? ''}
              onChange={(text) =>
                form.setValue('scope', text, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: true,
                })
              }
              ariaInvalid={!!form.formState.errors.scope}
            />
            <BidCharCounter
              value={form.watch('scope') ?? ''}
              min={20}
              max={8000}
              hint="markdown source"
            />
            {form.formState.errors.scope && (
              <p className="text-xs text-destructive">{form.formState.errors.scope.message}</p>
            )}
          </div>

          {rfpScope && (
            <AiDraftModal
              open={aiOpen}
              onOpenChange={setAiOpen}
              mode={{
                kind: 'bid',
                rfpScope: rfpScope,
                rfpTitle: rfpTitle,
                onAccept: (draft) => {
                  // Populate EVERY field of the bid form from the structured
                  // AI draft. The provider lands on a fully-filled form they
                  // can edit before submitting. Field name mapping mirrors
                  // the BidDraft → BidFormValues bridge:
                  //   priceUsdc           → price_usdc
                  //   timelineDays        → timeline_days
                  //   scope               → scope
                  //   milestones[i]       → milestones[i]   (field names
                  //                         transposed: amountUsdc → amount_usdc, etc.)
                  // shouldValidate runs the zod resolver so any out-of-bounds
                  // field flags inline immediately.
                  const setOpts = {
                    shouldValidate: true,
                    shouldDirty: true,
                    shouldTouch: true,
                  } as const;
                  form.setValue('price_usdc', draft.priceUsdc, setOpts);
                  form.setValue('timeline_days', draft.timelineDays, setOpts);
                  form.setValue('scope', draft.scope, setOpts);
                  form.setValue(
                    'milestones',
                    draft.milestones.map((m) => ({
                      name: m.name,
                      description: m.description,
                      amount_usdc: m.amountUsdc,
                      duration_days: m.durationDays,
                      success_criteria: m.successCriteria ?? '',
                    })),
                    setOpts,
                  );
                },
              }}
            />
          )}

          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <Label>Milestones ({fields.length})</Label>
              <span className="text-xs text-muted-foreground">
                Propose your delivery cadence. Amounts must sum to your bid price.
              </span>
            </div>
            {form.formState.errors.milestones?.root?.message && (
              <p className="rounded border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
                {form.formState.errors.milestones.root.message}
              </p>
            )}
            {fields.map((field, idx) => (
              <div
                key={field.id}
                className="flex flex-col gap-2 rounded border border-dashed border-border p-3"
              >
                <div className="grid grid-cols-4 gap-2">
                  <div className="col-span-2 flex flex-col gap-1">
                    <Label htmlFor={`m-name-${idx}`} className="text-xs">
                      Name
                    </Label>
                    <Input id={`m-name-${idx}`} {...form.register(`milestones.${idx}.name`)} />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`m-amt-${idx}`} className="text-xs">
                      Amount USDC
                    </Label>
                    <Input
                      id={`m-amt-${idx}`}
                      type="text"
                      inputMode="decimal"
                      {...form.register(`milestones.${idx}.amount_usdc`)}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      → ${formatNet(form.watch(`milestones.${idx}.amount_usdc`) ?? '0')} net
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`m-dur-${idx}`} className="text-xs">
                      Duration (days)
                    </Label>
                    <Input
                      id={`m-dur-${idx}`}
                      type="number"
                      min={0}
                      max={365}
                      {...form.register(`milestones.${idx}.duration_days`, { valueAsNumber: true })}
                    />
                    <span className="font-mono text-[10px] text-muted-foreground">
                      0 = no deadline
                    </span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`m-desc-${idx}`} className="text-xs">
                    Description
                  </Label>
                  <Textarea
                    id={`m-desc-${idx}`}
                    rows={2}
                    {...form.register(`milestones.${idx}.description`)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`m-success-${idx}`} className="text-xs">
                    Success criteria <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id={`m-success-${idx}`}
                    rows={2}
                    placeholder="What does done look like? E.g. ‘all 12 endpoints documented + Postman collection + 90%+ test coverage’"
                    {...form.register(`milestones.${idx}.success_criteria`)}
                  />
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    The acceptance bar you commit to. Surfaces in the milestone row so the buyer
                    knows exactly what they're approving against - and referenced inline if the
                    milestone hits the dispute path.
                  </p>
                </div>
                {fields.length > 1 && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(idx)}
                      className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      Remove milestone
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {fields.length < 8 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  // Empty defaults - provider fills in everything explicitly.
                  // Numeric fields use `undefined` cast through any so the
                  // input renders blank instead of 0/14 placeholders, matching
                  // the initial-row defaults at form construction.
                  append({
                    name: '',
                    description: '',
                    // biome-ignore lint/suspicious/noExplicitAny: numeric blank
                    amount_usdc: '' as any,
                    // biome-ignore lint/suspicious/noExplicitAny: numeric blank
                    duration_days: undefined as any,
                    success_criteria: '',
                  })
                }
                className="w-fit gap-1.5 rounded-full px-4 text-xs"
              >
                + Add milestone
              </Button>
            )}
          </div>

          {/* v2 — replaced the explicit "Fund via Cloak" orange-box double-
              button (EphemeralFundingPanel) with an auto-fund step in the
              submit handler. We surface a single fuchsia note here so the
              provider knows what'll happen on Submit, mirroring the
              create-RFP private flow's "~0.06 SOL via Cloak" line. */}
          {isPrivateMode && (
            <span className="rounded-md border border-fuchsia-500/20 bg-fuchsia-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground/80">
              <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">
                ≈ 0.08 SOL via Cloak
              </span>{' '}
              auto-deposited when you submit (only if your bidder ephemeral is short of SOL). It
              pays for the bid PDA rent + PER infra + tx fees so your main wallet never appears as
              the bidder. Bid envelope size matters here — long scope + many milestones grow rent.
              Unused SOL refundable anytime from your Dashboard via Ephemeral Sweep.
            </span>
          )}

          <input type="hidden" {...form.register('payout_address')} value={account.address} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              rows={3}
              placeholder="Anything else the buyer should know."
              {...form.register('notes')}
            />
          </div>
        </CardContent>
      </Card>

      {stage && (
        <div className="flex w-full">
          <BidComposerProgress stage={stage} />
        </div>
      )}
      <div className="flex items-center justify-end gap-3">
        <Button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-full px-6 shadow-md shadow-primary/25"
        >
          {submitting ? 'Submitting…' : 'Encrypt + commit bid'}
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* AboutYourBid — single notice covering both privacy facts (encryption +     */
/* identity). Merges the previous standalone "encrypted to buyer" box with    */
/* the bottom-of-form PrivacyModeIndicator so the bidder sees one short       */
/* paragraph at the top instead of two near-identical blocks straddling the   */
/* form fields.                                                               */
/* -------------------------------------------------------------------------- */

function AboutYourBid({ isPrivate, mainWallet }: { isPrivate: boolean; mainWallet: string }) {
  // SNS resolution for the connected main wallet — safe (this IS the user's
  // main wallet, already known to be public when bidding in non-private mode).
  // In private mode the bid signer is the ephemeral, NOT main; we still
  // resolve main here only to render the "you'll bid AS alice.sol" indicator
  // — the resolution is local, no on-chain trace tied to the bid.
  const mainSnsName = useSnsName(mainWallet as Address);
  const mainDisplay = mainSnsName ?? `${mainWallet.slice(0, 8)}…${mainWallet.slice(-4)}`;
  return (
    <div
      className={cn(
        'rounded-xl border p-4 text-xs leading-relaxed',
        isPrivate ? 'border-primary/40 bg-primary/5' : 'border-border bg-card/30',
      )}
    >
      <div className="mb-1 text-sm font-medium text-foreground">
        {isPrivate ? 'Encrypted bid · private bidder' : 'Encrypted bid · public bidder'}
      </div>
      <p className="text-muted-foreground">
        Bid contents (price, scope, milestones) are encrypted to the buyer's RFP-specific X25519
        pubkey — only the buyer can decrypt; nothing about contents is visible on-chain to other
        bidders.{' '}
        {isPrivate ? (
          <>
            Bidder identity is hidden too: your bid is signed by a fresh ephemeral wallet derived
            from your HD keychain — your main wallet doesn't appear on chain during bidding, at
            award, or across any post-award action (start / submit milestone, disputes, refunds).
            Payout lands on the same ephemeral, and reputation counters accumulate on that
            ephemeral's on-chain rep account. Your main wallet stays unlinked unless you{' '}
            <strong>claim</strong> the win post-completion from Dashboard — at which point the
            counters merge into your public provider profile via an explicit on-chain attest tx.
            Until you claim (or if you choose never to), the win remains anonymous on chain. Losers
            stay anonymous forever.
          </>
        ) : (
          <>
            Your bid is signed by your main wallet, so anyone scanning on-chain sees the bid was
            placed by{' '}
            <span className="font-mono text-foreground" title={mainWallet}>
              {mainDisplay}
            </span>
            . Reputation accrues to that wallet on each accepted milestone.
          </>
        )}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* EphemeralFundingPanel - one-click "send 0.03 SOL from main → ephemeral"    */
/* via Phantom. Visible only when payout mode is ephemeral and the wallet's   */
/* balance is below the threshold needed to submit a bid.                     */
/* -------------------------------------------------------------------------- */

export function EphemeralFundingPanel({
  ephemeralPubkey,
}: {
  ephemeralPubkey: string;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  const [funding, setFunding] = useState(false);
  const [fundProgress, setFundProgress] = useState<string | null>(null);
  const account = useTendrAccount();
  const signTransactions = useTendrSignTransactions(account!);
  const signMessageHook = useTendrSignMessage(account!);
  // Wrap the @solana/react hook into Cloak's expected (Uint8Array) → Promise<Uint8Array>.
  const signMessageProp = async (msg: Uint8Array): Promise<Uint8Array> => {
    const { signature } = await signMessageHook({ message: msg });
    return signature;
  };

  // Poll the balance every 5s while panel is mounted. Pure kit - no web3.js.
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const { value } = await rpc.getBalance(ephemeralPubkey as Address).send();
        if (!cancelled) setBalance(Number(value) / 1e9);
      } catch {
        /* ignore */
      }
    }
    void check();
    const id = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ephemeralPubkey]);

  async function handleFund() {
    if (!account) return;
    setFunding(true);
    try {
      // Cloak shielded funding via wallet-adapter (no private key export).
      // 1 Phantom popup for the deposit; relay-paid withdraw to ephemeral
      // happens silently after. Cryptographic unlinkability via the UTXO pool.
      // signMessage / signTransactions are top-level hooks (mounted via
      // @/lib/wallet — see top of this component); we just close over them
      // here.
      const [{ fundEphemeralWallet }, { Connection, PublicKey }] = await Promise.all([
        import('@/lib/sdks/cloak'),
        import('@solana/web3.js'),
      ]);

      // Bridge wallet-standard's batched signTransactions hook to Cloak's
      // single-tx signTransaction contract. The shared adapter lives in
      // lib/wallet/sign.ts so every Cloak-touching surface (here, buyer-
      // action-panel, future flows) shares one canonical implementation
      // that's wallet-standard-portable (Phantom, Backpack, Solflare,
      // Nightly, etc — anything implementing `solana:signTransaction`).
      const { buildCloakSignTransactionAdapter } = await import('@/lib/wallet');
      const signTxAdapter = await buildCloakSignTransactionAdapter(signTransactions);

      // signMessage is also needed by Cloak (for viewing-key registration).
      // We can't call useSignMessage here because it's a hook - instead
      // signMessage was passed in as a prop closure from the parent.
      const result = await fundEphemeralWallet({
        walletPublicKey: new PublicKey(account.address),
        signTransaction: signTxAdapter,
        signMessage: signMessageProp,
        ephemeralPubkey: new PublicKey(ephemeralPubkey),
        depositLamports: 60_000_000n, // 0.06 SOL - covers Cloak fee + ephemeral rent + bid PDA rent (envelope-size dependent) + tx fees with comfortable headroom
        connection: new Connection(
          process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
          {
            commitment: 'confirmed',
            // Strip web3.js's auto-injected `solana-client` header so RPC
            // providers (RPC Fast) don't reject the CORS preflight.
            // biome-ignore lint/suspicious/noExplicitAny: web3.js FetchMiddleware type
            fetchMiddleware: stripSolanaClientHeaderMiddleware as any,
          },
        ),
        onProgress: (p) => setFundProgress(p.stage),
      });
      toast.success('Privacy wallet funded via Cloak shielded pool', {
        description: <TxToastDescription hash={result.withdrawSig} prefix="Withdraw tx" />,
        duration: 10000,
      });
    } catch (e) {
      toast.error('Funding failed', { description: String((e as Error).message ?? e) });
    } finally {
      setFunding(false);
      setFundProgress(null);
    }
  }

  if (balance === null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        <span>Checking privacy wallet balance…</span>
        <HashLink hash={ephemeralPubkey} kind="account" visibleChars={6} />
      </div>
    );
  }

  // Required ephemeral balance for a full bid round-trip:
  //   ~0.011 SOL - BidCommit account rent (envelope-size dependent; a typical bid is ~1.5KB)
  //   ~0.011 SOL - PER infra (permission + delegation_record + delegation_metadata + buffer)
  //   ~0.001 SOL - base-layer + ER tx fees
  //   ~0.005 SOL - Cloak shielded-funding fee (subtracted from deposit, not from ephemeral)
  // Total in-ephemeral need: ~0.024 SOL minimum. We require 0.04 SOL so the
  // user has comfortable headroom for larger envelopes (private RFPs with
  // detailed scope/milestones can grow). Cloak funding sends 0.06 SOL → after
  // ~0.005 SOL Cloak fee → ephemeral receives ~0.055 SOL → comfortable.
  const requiredSol = 0.04;
  if (balance >= requiredSol) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Privacy wallet funded: <span className="font-mono">{balance.toFixed(4)} SOL</span>.
            Ready to submit.
          </span>
          {/* Address surfaced inline so the provider can verify the wallet
              that just got Cloak-funded matches the one signing the bid +
              copy it to the explorer. */}
          <HashLink hash={ephemeralPubkey} kind="account" visibleChars={6} />
        </div>
        <button
          type="button"
          onClick={handleFund}
          disabled={funding}
          className="self-start text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {funding
            ? humanizeStage(fundProgress, 'Topping up')
            : 'Top up more (for very large bids)'}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-amber-700 dark:text-amber-400">
          <strong>Privacy wallet needs SOL.</strong> Currently has{' '}
          <span className="font-mono">{balance.toFixed(4)} SOL</span>; needs ≥{requiredSol} SOL for
          bid PDA rent + PER infrastructure + tx fees. Rent is refunded on withdraw or after award.
        </p>
        <HashLink hash={ephemeralPubkey} kind="account" visibleChars={6} />
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={funding}
        onClick={handleFund}
        className="min-w-[14rem] self-start"
      >
        {funding
          ? humanizeStage(fundProgress, 'Funding')
          : balance > 0
            ? 'Top up via Cloak (sends 0.06 SOL)'
            : 'Fund 0.06 SOL via Cloak'}
      </Button>
      <ul className="ml-3 flex list-disc flex-col gap-0.5 text-[10px] text-muted-foreground marker:text-muted-foreground/40">
        <li>
          <strong className="text-foreground">No on-chain main→ephemeral link.</strong> Your main
          wallet deposits to the Cloak shielded pool; the ephemeral receives from the pool via a
          relay-paid withdrawal. Observers see two unlinked transfers.
        </li>
        <li>
          <strong className="text-foreground">Cloak fee:</strong> ~0.005 SOL per shielded transfer
          (deducted from the deposit). Of the 0.06 SOL sent, ~0.055 SOL lands on the ephemeral.
        </li>
        <li>
          <strong className="text-foreground">Bid size matters:</strong> rent for the bid account
          scales with the encrypted envelope (scope + milestone count). A long scope with 8
          milestones can add a few thousand lamports - top up again if needed.
        </li>
        <li>
          <strong className="text-foreground">Sweep anytime:</strong> any unused SOL on the
          ephemeral can be sent back to your main wallet via the same shielded path (look for "Sweep
          ephemeral funds back" on the RFP page).
        </li>
      </ul>
    </div>
  );
}
