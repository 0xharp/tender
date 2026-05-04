'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useSelectedWalletAccount, useSignMessage, useSignTransactions } from '@solana/react';
import type { Keypair } from '@solana/web3.js';
import type { UiWalletAccount } from '@wallet-standard/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import type { BidderVisibility } from '@/lib/bids/schema';
import { type BidFormValues, bidFormSchema } from '@/lib/bids/schema';
import {
  type BidSubmitStage,
  type PayoutMode,
  type SubmitBidResult,
  submitBid,
} from '@/lib/bids/submit-flow';
import { prefetchCloak } from '@/lib/sdks/cloak';
import { useSnsName } from '@/lib/sns/hooks';
import { rpc } from '@/lib/solana/client';
import type { Address } from '@solana/kit';

/** Circle's devnet USDC mint - same SPL token used by MagicBlock Private Payments
 *  defaults. One-line swap to Circle mainnet (`EPjFWdd5…`) for V2. */
const DEVNET_MOCK_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as const;

const STAGE_LABEL: Record<BidSubmitStage, string> = {
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
  const [account] = useSelectedWalletAccount();

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

function BidCharCounter({ value, min, max }: { value: string; min: number; max: number }) {
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
      {len} / {max} characters
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
}: { account: UiWalletAccount } & BidComposerProps) {
  const feePct = (feeBps / 100).toFixed(feeBps % 100 === 0 ? 1 : 2);
  const netRatio = (10_000 - feeBps) / 10_000;
  const formatNet = (gross: string): string => {
    const n = Number(gross);
    if (!Number.isFinite(n) || n <= 0) return '0';
    return (n * netRatio).toFixed(2);
  };
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const signMessage = useSignMessage(account);
  const [stage, setStage] = useState<BidSubmitStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SubmitBidResult | null>(null);
  // Privacy mode is determined by the RFP's bidder_visibility setting (set by
  // the buyer at create time). Provider doesn't choose it - they get the mode
  // the buyer picked.
  const isPrivateMode = bidderVisibility === 'buyer_only';
  // In private mode, the ephemeral keypair is derived deterministically from
  // a main-wallet signed message + HKDF. Same RFP + same main wallet always
  // produces the same keypair → no localStorage backup needed, recoverable
  // on any device. Generated lazily at submit time (not on mount) so we don't
  // pop a wallet popup just for opening the page.
  const [ephemeralKeypair, setEphemeralKeypair] = useState<Keypair | null>(null);
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
        // Private mode prep: derive ephemeral keypair + sign binding message.
        // 1. Derive ephemeral keypair deterministically from main wallet sig.
        const {
          deriveEphemeralBidWalletMessage,
          deriveEphemeralBidKeypair,
          buildBidBindingMessage,
        } = await import('@/lib/crypto/derive-ephemeral-bid-wallet');
        const seedMsg = deriveEphemeralBidWalletMessage(rfpPda);
        // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
        const seedSig = await (signMessage as any)({ message: seedMsg });
        const eph = await deriveEphemeralBidKeypair(seedSig.signature);
        setEphemeralKeypair(eph);

        // 2. Compute the bid PDA from the ephemeral pubkey (same way program does).
        const { findBidPda: findBidPdaFn } = await import('@tender/tender-client');
        const [bidPdaForBinding] = await findBidPdaFn({
          // biome-ignore lint/suspicious/noExplicitAny: kit Address brand
          rfp: rfpPda as any,
          bidPdaSeed: eph.publicKey.toBytes(),
        });

        // 3. Sign the binding message with the MAIN wallet - proves main owns this bid.
        const bindingMsg = buildBidBindingMessage(rfpPda, bidPdaForBinding, account.address);
        // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
        const bindingSig = await (signMessage as any)({ message: bindingMsg });

        payoutMode = {
          kind: 'ephemeral',
          ephemeralKeypair: eph,
          mainWallet: account.address as Address,
          bindingSignature: bindingSig.signature,
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
              href={`/providers/${account.address}`}
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
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="text-base">Sealed bid</CardTitle>
          <StatusPill tone="sealed">encrypt to buyer</StatusPill>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-xl border border-dashed border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            Your bid will be encrypted to the buyer&rsquo;s RFP-specific X25519 pubkey. Only the
            buyer can decrypt it; other bidders see nothing about its contents on-chain.
          </div>

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

          <div className="rounded-xl border border-dashed border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground">Platform fee: {feePct}%</p>
            <p className="mt-1 text-muted-foreground">
              Deducted from each milestone payout when the buyer accepts. Quote the gross amounts
              you want to bill - you'll receive {(netRatio * 100).toFixed(2)}% per milestone. Locked
              per-RFP at create time, so the rate can't change underneath you.
            </p>
          </div>

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
                After {feePct}% fee you'll receive ~$
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
            <Label htmlFor="scope">Scope</Label>
            <Textarea
              id="scope"
              rows={5}
              placeholder="What you&rsquo;ll deliver, your approach, exclusions, assumptions."
              {...form.register('scope')}
            />
            <BidCharCounter value={form.watch('scope') ?? ''} min={20} max={8000} />
            {form.formState.errors.scope && (
              <p className="text-xs text-destructive">{form.formState.errors.scope.message}</p>
            )}
          </div>

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

          <PrivacyModeIndicator isPrivate={isPrivateMode} mainWallet={account.address} />

          {isPrivateMode && ephemeralKeypair && (
            <EphemeralFundingPanel ephemeralPubkey={ephemeralKeypair.publicKey.toBase58()} />
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

      <div className="flex items-center justify-end gap-3">
        {stage && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
            {STAGE_LABEL[stage]}
          </span>
        )}
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
/* Privacy mode indicator - read-only, derived from RFP's bidder_visibility.  */
/* No 3-mode selector anymore: provider gets the mode the buyer picked.       */
/* -------------------------------------------------------------------------- */

function PrivacyModeIndicator({
  isPrivate,
  mainWallet,
}: { isPrivate: boolean; mainWallet: string }) {
  // SNS resolution for the connected main wallet — safe (this IS the user's
  // main wallet, already known to be public when bidding in non-private mode).
  // In private mode the bid signer is the ephemeral, NOT main; we still
  // resolve main here only to render the "you'll bid AS alice.sol" indicator
  // — the resolution is local, no on-chain trace tied to the bid.
  const mainSnsName = useSnsName(mainWallet as Address);
  const mainDisplay = mainSnsName ?? `${mainWallet.slice(0, 8)}…${mainWallet.slice(-4)}`;
  if (!isPrivate) {
    return (
      <div className="rounded-xl border border-border bg-card/30 p-4 text-xs leading-relaxed">
        <div className="mb-1 text-sm font-medium text-foreground">Public bidder list</div>
        <p className="text-muted-foreground">
          Anyone scanning this RFP on-chain will see your bid was placed by
          <span className="ml-1 font-mono" title={mainWallet}>
            {mainDisplay}
          </span>
          . Bid contents (price, scope, milestones) stay sealed until the buyer reveals. Reputation
          accrues to your main wallet on each accepted milestone.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-xs leading-relaxed">
      <div className="mb-1 text-sm font-medium text-foreground">Private bidder list</div>
      <p className="text-muted-foreground">
        At submit, you'll sign two messages with your main wallet: (1) derive a deterministic
        ephemeral wallet for this RFP, and (2) cryptographically bind your main wallet to the bid
        (verified on-chain only at award time). The ephemeral wallet signs all bid txs - your main
        wallet doesn't appear on chain during bidding. If you win, the binding signature is
        decrypted by the buyer + verified on-chain via Solana's Ed25519 program; payment +
        reputation flow to your main wallet. Losers' main wallets stay forever private.
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
  const [account] = useSelectedWalletAccount();
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
  const signTransactions = useSignTransactions(account!, 'solana:devnet') as any;
  const signMessageHook = useSignMessage(account!);
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
      const [{ fundEphemeralWallet }, { Connection, PublicKey }, signMessageHook] =
        await Promise.all([
          import('@/lib/sdks/cloak'),
          import('@solana/web3.js'),
          import('@solana/react').then((m) => m.useSignMessage),
        ]);
      void signMessageHook; // hooks must be called at top level - see signMessageFn below

      // Bridge Phantom's signTransactions hook (signs raw bytes) → Cloak's
      // signTransaction (takes a Transaction object). Cloak passes either
      // legacy Transaction or VersionedTransaction; we serialize, sign via
      // Phantom, and deserialize back into the same shape.
      const { Transaction, VersionedTransaction } = await import('@solana/web3.js');
      const signTxAdapter = async <
        T extends
          | import('@solana/web3.js').Transaction
          | import('@solana/web3.js').VersionedTransaction,
      >(
        tx: T,
      ): Promise<T> => {
        const isV0 = !(tx instanceof Transaction);
        const serialized = isV0
          ? (tx as import('@solana/web3.js').VersionedTransaction).serialize()
          : (tx as import('@solana/web3.js').Transaction).serialize({
              requireAllSignatures: false,
            });
        const [signed] = await signTransactions({ transaction: new Uint8Array(serialized) });
        if (isV0) {
          return VersionedTransaction.deserialize(signed.signedTransaction) as unknown as T;
        }
        return Transaction.from(signed.signedTransaction) as unknown as T;
      };

      // signMessage is also needed by Cloak (for viewing-key registration).
      // We can't call useSignMessage here because it's a hook - instead
      // signMessage was passed in as a prop closure from the parent.
      const result = await fundEphemeralWallet({
        walletPublicKey: new PublicKey(account.address),
        signTransaction: signTxAdapter,
        signMessage: signMessageProp,
        ephemeralPubkey: new PublicKey(ephemeralPubkey),
        depositLamports: 60_000_000n, // 0.06 SOL - covers Cloak fee + ephemeral rent + bid PDA rent (envelope-size dependent) + tx fees with comfortable headroom
        connection: new Connection('https://api.devnet.solana.com', 'confirmed'),
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
      <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        Checking privacy wallet balance…
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
        <span>
          Privacy wallet funded: <span className="font-mono">{balance.toFixed(4)} SOL</span>. Ready
          to submit.
        </span>
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
      <p className="text-amber-700 dark:text-amber-400">
        <strong>Privacy wallet needs SOL.</strong> Currently has{' '}
        <span className="font-mono">{balance.toFixed(4)} SOL</span>; needs ≥{requiredSol} SOL for
        bid PDA rent + PER infrastructure + tx fees. Rent is refunded on withdraw or after award.
      </p>
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
