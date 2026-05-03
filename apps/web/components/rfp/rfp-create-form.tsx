'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useSelectedWalletAccount, useSignMessage, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { friendlyBidError } from '@/lib/bids/error-utils';
import { type SubmitStage, submitRfpCreate } from '@/lib/rfps/create-flow';
import { RFP_CATEGORIES, type RfpFormValues, rfpFormSchema } from '@/lib/rfps/schema';
import { rpc, rpcSubscriptions } from '@/lib/solana/client';

function CharCounter({ value, min, max }: { value: string; min: number; max: number }) {
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

const STAGE_LABEL: Record<SubmitStage, string> = {
  deriving_keypair: 'Sign the encryption-key derivation message…',
  building_tx: 'Building the on-chain transaction…',
  awaiting_signature: 'Approve the transaction in your wallet…',
  confirming_tx: 'Waiting for devnet confirmation…',
  saving_metadata: 'Saving RFP metadata…',
};

export function RfpCreateForm() {
  const [account] = useSelectedWalletAccount();

  if (!account) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Connect a wallet to create an RFP</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Use the wallet picker in the top nav. The form will appear here once a wallet is
            selected.
          </p>
        </CardContent>
      </Card>
    );
  }

  return <ConnectedForm account={account} />;
}

function ConnectedForm({ account }: { account: UiWalletAccount }) {
  const signMessage = useSignMessage(account);
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const router = useRouter();
  const [stage, setStage] = useState<SubmitStage | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<RfpFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: zod default + react-hook-form Resolver type drift
    resolver: zodResolver(rfpFormSchema) as any,
    // No defaults that pre-fill meaningful values, but controlled fields
    // (Select, radio) need a DEFINED initial value to stay controlled across
    // their lifetime - Base UI warns when value flips from `undefined` to a
    // string. Empty string is treated as "nothing selected" for those.
    defaultValues: {
      title: '',
      // biome-ignore lint/suspicious/noExplicitAny: zod default vs RHF Resolver type drift
      category: '' as any,
      scope_summary: '',
      reserve_price_usdc: '',
      // Numeric <Input>s are uncontrolled HTML - undefined is safe.
      // biome-ignore lint/suspicious/noExplicitAny: numeric input default
      bid_window_hours: undefined as any,
      // biome-ignore lint/suspicious/noExplicitAny: numeric input default
      reveal_window_hours: undefined as any,
      // biome-ignore lint/suspicious/noExplicitAny: zod default vs RHF Resolver type drift
      bidder_visibility: '' as any,
    },
  });

  async function onSubmit(values: RfpFormValues) {
    setSubmitting(true);
    setStage(null);
    try {
      const result = await submitRfpCreate({
        // wallet-standard's UiWalletAccount.address is plain string;
        // kit's findRfpPda expects an Address-branded string.
        // biome-ignore lint/suspicious/noExplicitAny: brand-only conversion
        wallet: account.address as any,
        values,
        signMessage,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        rpc,
        rpcSubscriptions,
        onProgress: setStage,
      });
      toast.success('RFP posted to devnet', {
        description: <TxToastDescription hash={result.txSignature} prefix="Tx" />,
        duration: 8000,
      });
      router.push(`/rfps/${result.rfpPda}`);
    } catch (e) {
      toast.error('RFP create failed', { description: friendlyBidError(e) });
    } finally {
      setSubmitting(false);
      setStage(null);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Post a new RFP</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="title">Title</Label>
            <Input id="title" placeholder="Smart-contract audit" {...form.register('title')} />
            <CharCounter value={form.watch('title') ?? ''} min={3} max={200} />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category">Category</Label>
            <Select
              value={form.watch('category')}
              onValueChange={(v) =>
                form.setValue('category', v as RfpFormValues['category'], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger id="category" className="w-full justify-between">
                <SelectValue placeholder="select a category" className="lowercase" />
              </SelectTrigger>
              <SelectContent>
                {RFP_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c} className="lowercase">
                    {c.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.category && (
              <p className="text-xs text-destructive">{form.formState.errors.category.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scope_summary">Scope summary</Label>
            <Textarea
              id="scope_summary"
              rows={6}
              placeholder="What you need delivered, success criteria, exclusions, deadlines."
              {...form.register('scope_summary')}
            />
            <CharCounter value={form.watch('scope_summary') ?? ''} min={20} max={4000} />
            {form.formState.errors.scope_summary && (
              <p className="text-xs text-destructive">
                {form.formState.errors.scope_summary.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bid_window_hours">Bid window (hours)</Label>
              <Input
                id="bid_window_hours"
                type="number"
                min={1}
                max={336}
                {...form.register('bid_window_hours', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                How long providers can submit sealed bids.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reveal_window_hours">Reveal window (hours)</Label>
              <Input
                id="reveal_window_hours"
                type="number"
                min={1}
                max={336}
                {...form.register('reveal_window_hours', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                How long you have to review + award after bidding closes.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="reserve_price_usdc">
              Reserve price <span className="text-muted-foreground">(optional, sealed)</span>
            </Label>
            <Input
              id="reserve_price_usdc"
              type="text"
              inputMode="decimal"
              placeholder="e.g. 30000 (USDC) - leave empty for no reserve"
              {...form.register('reserve_price_usdc')}
            />
            <p className="text-xs text-muted-foreground">
              Maximum you'll accept. Sealed during bidding (only a SHA-256 commitment goes
              on-chain); revealed when you award. The program rejects winning bids over the reserve.
              No reserve = you may award at any price.
            </p>
            {form.formState.errors.reserve_price_usdc && (
              <p className="text-xs text-destructive">
                {form.formState.errors.reserve_price_usdc.message}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Privacy</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="rounded-xl border border-dashed border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed">
            <p className="font-medium text-foreground">
              Bid contents are sealed until the bid window closes - even from you.
            </p>
            <p className="mt-1 text-muted-foreground">
              Enforced cryptographically by the MagicBlock TEE-backed validator, not by policy. Once
              bidding closes, you decrypt bids in your browser (one wallet signature) to evaluate
              them, then award the winner. The choice below adds a second privacy layer: keep bidder
              identities anonymous too.{' '}
              <a
                href="/docs/privacy-model"
                className="underline underline-offset-2 hover:text-primary"
              >
                Read the model →
              </a>
            </p>
          </div>

          <fieldset className="flex flex-col gap-2.5" aria-describedby="visibility-help">
            <legend className="mb-1 text-sm font-medium">Privacy mode</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
              <input
                type="radio"
                value="public"
                {...form.register('bidder_visibility')}
                className="mt-0.5 size-4 cursor-pointer accent-primary"
              />
              <span className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Bid contents private</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Bid amount, scope, and milestones stay sealed in the TEE until you award. Each bid
                  is signed by the provider's main wallet, so anyone scanning the program can list{' '}
                  <em>who</em> bid (but never <em>what</em> they bid). Builds public vendor
                  reputation.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
              <input
                type="radio"
                value="buyer_only"
                {...form.register('bidder_visibility')}
                className="mt-0.5 size-4 cursor-pointer accent-primary"
              />
              <span className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Bid contents + bidder identity private</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Same content sealing, plus each bid is signed by a per-RFP ephemeral wallet
                  derived deterministically from the provider's main-wallet signature. No on-chain
                  link from bid back to main wallet - until the provider wins and reveals. Losers
                  stay anonymous forever.
                </span>
              </span>
            </label>
          </fieldset>
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
          {submitting ? 'Posting…' : 'Post RFP'}
        </Button>
      </div>
    </form>
  );
}
