'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  useSelectedWalletAccount,
  useSignMessage,
  useWalletAccountTransactionSendingSigner,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import Link from 'next/link';
import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { type BidFormValues, bidFormSchema } from '@/lib/bids/schema';
import { type BidSubmitStage, type SubmitBidResult, submitBid } from '@/lib/bids/submit-flow';
import { rpc, rpcSubscriptions } from '@/lib/solana/client';

const STAGE_LABEL: Record<BidSubmitStage, string> = {
  deriving_provider_key: 'Approve the derive-key signature in your wallet…',
  encrypting: 'Encrypting bid to buyer + provider pubkeys…',
  building_tx: 'Building the on-chain transaction…',
  awaiting_signature: 'Approve the transaction in your wallet…',
  confirming_tx: 'Waiting for devnet confirmation…',
  saving_metadata: 'Saving sealed bid…',
};

export interface BidComposerProps {
  rfpId: string;
  rfpPda: string;
  buyerEncryptionPubkeyHex: string;
  budgetMaxUsdc: string;
  milestoneCount: number;
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
  buyerEncryptionPubkeyHex,
  budgetMaxUsdc,
  milestoneCount,
}: { account: UiWalletAccount } & BidComposerProps) {
  const sendingSigner = useWalletAccountTransactionSendingSigner(account, 'solana:devnet');
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
        // biome-ignore lint/suspicious/noExplicitAny: kit Address is brand-only conversion
        rfpPda: rfpPda as any,
        buyerEncryptionPubkeyHex,
        values,
        // biome-ignore lint/suspicious/noExplicitAny: same
        providerWallet: account.address as any,
        // biome-ignore lint/suspicious/noExplicitAny: kit signer type narrows at hook call site
        signMessage: signMessage as any,
        sendingSigner,
        rpc,
        rpcSubscriptions,
        onProgress: setStage,
      });
      setSuccess(result);
      toast.success('Sealed bid committed', {
        description: `tx ${result.txSignature.slice(0, 8)}…`,
        duration: 8000,
      });
    } catch (e) {
      toast.error('Bid commit failed', { description: (e as Error).message, duration: 12000 });
    } finally {
      setSubmitting(false);
      setStage(null);
    }
  }

  if (success) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">✓ Sealed bid committed on-chain</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Your bid is encrypted to the buyer&rsquo;s pubkey and committed to devnet. Other
            providers see only the commit hash; only the buyer can decrypt your proposal at the
            reveal window.
          </p>
          <div className="flex flex-col gap-2 rounded border border-dashed border-border p-3 font-mono text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">bid PDA</span>
              <Link
                href={`https://solscan.io/account/${success.bidPda}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline"
              >
                {success.bidPda.slice(0, 8)}…{success.bidPda.slice(-8)}
              </Link>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">commit tx</span>
              <Link
                href={`https://solscan.io/tx/${success.txSignature}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all underline"
              >
                {success.txSignature.slice(0, 8)}…{success.txSignature.slice(-8)}
              </Link>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">commit hash</span>
              <span className="break-all">{success.commitHashHex.slice(0, 16)}…</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/rfps/${rfpPda}`}
              className="inline-flex h-9 items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
            >
              ← back to RFP
            </Link>
            <Link
              href={`/providers/${account.address}`}
              className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-4 text-sm font-medium transition-colors hover:bg-card"
            >
              your provider profile
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Sealed bid</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
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
        {stage && <span className="text-xs text-muted-foreground">{STAGE_LABEL[stage]}</span>}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : 'Encrypt + commit bid'}
        </Button>
      </div>
    </form>
  );
}
