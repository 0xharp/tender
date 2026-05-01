'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  useSelectedWalletAccount,
  useSignMessage,
  useSignTransactions,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import Link from 'next/link';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { DataField } from '@/components/primitives/data-field';
import { HashLink } from '@/components/primitives/hash-link';
import { StatusPill } from '@/components/primitives/status-pill';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { friendlyBidError } from '@/lib/bids/error-utils';
import type { BidderVisibility } from '@/lib/bids/schema';
import { type BidFormValues, bidFormSchema } from '@/lib/bids/schema';
import { type BidSubmitStage, type SubmitBidResult, submitBid } from '@/lib/bids/submit-flow';
import { rpc } from '@/lib/solana/client';

const STAGE_LABEL: Record<BidSubmitStage, string> = {
  deriving_provider_key: 'Approve the derive-key signature in your wallet…',
  deriving_bid_seed: 'Approve the private bid seed signature…',
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
  budgetMaxUsdc: string;
  milestoneCount: number;
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

function evenDefaults(count: number, total: string) {
  const totalNum = Number(total) || 0;
  const each = (totalNum / count).toFixed(2);
  return Array.from({ length: count }, (_, i) => ({
    name: `Milestone ${i + 1}`,
    description: `Milestone ${i + 1} deliverable`,
    amount_usdc: each,
  }));
}

function ConnectedComposer({
  account,
  rfpId,
  rfpPda,
  rfpNonceHex,
  bidderVisibility,
  buyerEncryptionPubkeyHex,
  budgetMaxUsdc,
  milestoneCount,
}: { account: UiWalletAccount } & BidComposerProps) {
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const signMessage = useSignMessage(account);
  const [stage, setStage] = useState<BidSubmitStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SubmitBidResult | null>(null);

  const initialPrice = String(Math.floor(Number(budgetMaxUsdc) * 0.9));

  const form = useForm<BidFormValues>({
    resolver: zodResolver(bidFormSchema),
    defaultValues: {
      price_usdc: initialPrice,
      scope: '',
      timeline_days: 30,
      milestones: evenDefaults(milestoneCount, initialPrice),
      payout_address: account.address,
      notes: '',
    },
  });

  const { fields } = useFieldArray({ control: form.control, name: 'milestones' });

  async function onSubmit(values: BidFormValues) {
    setSubmitting(true);
    setStage(null);
    try {
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
        // biome-ignore lint/suspicious/noExplicitAny: kit signer narrowing at hook call site
        signMessage: signMessage as any,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        rpc,
        onProgress: setStage,
      });
      setSuccess(result);
      toast.success('Sealed bid committed', {
        description: `init ${result.initTxSignature.slice(0, 8)}… · finalize ${result.finalizeTxSignature.slice(0, 8)}…`,
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
            Your bid is encrypted to the buyer&rsquo;s pubkey and committed to devnet. Other
            providers see only the commit hash; only the buyer can decrypt your proposal at the
            reveal window.
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
            <DataField
              label="commit hash"
              hint="sha256 of your encrypted bid envelopes (buyer + provider). Stored on the BidCommit account; verified by finalize_bid against the bytes you wrote. If anyone tampers with the envelopes on PER, the hash check fails."
              value={<HashLink hash={success.commitHashHex} kind="none" visibleChars={8} />}
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
            buyer can decrypt it. Other bidders see only your commit hash on-chain.
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
            {form.formState.errors.scope && (
              <p className="text-xs text-destructive">{form.formState.errors.scope.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <Label>Milestones ({fields.length})</Label>
              <span className="text-xs text-muted-foreground">Sum must match your bid price.</span>
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
                <div className="grid grid-cols-3 gap-2">
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
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="payout_address">Payout address (Solana)</Label>
            <Input
              id="payout_address"
              type="text"
              className="font-mono text-xs"
              {...form.register('payout_address')}
            />
            <p className="text-xs text-muted-foreground">
              Defaults to your connected wallet. Cross-chain payout selector arrives later.
            </p>
          </div>

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
