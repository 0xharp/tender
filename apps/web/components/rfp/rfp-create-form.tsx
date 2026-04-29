'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  useSelectedWalletAccount,
  useSignMessage,
  useWalletAccountTransactionSendingSigner,
} from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

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
import { type SubmitStage, submitRfpCreate } from '@/lib/rfps/create-flow';
import { RFP_CATEGORIES, type RfpFormValues, rfpFormSchema } from '@/lib/rfps/schema';
import { rpc, rpcSubscriptions } from '@/lib/solana/client';

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
  const sendingSigner = useWalletAccountTransactionSendingSigner(account, 'solana:devnet');
  const router = useRouter();
  const [stage, setStage] = useState<SubmitStage | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<RfpFormValues>({
    resolver: zodResolver(rfpFormSchema),
    defaultValues: {
      title: '',
      category: 'audit',
      scope_summary: '',
      budget_max_usdc: '50000',
      bid_window_hours: 72,
      reveal_window_hours: 48,
      milestone_count: 3,
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
        sendingSigner,
        rpc,
        rpcSubscriptions,
        onProgress: setStage,
      });
      toast.success('RFP posted to devnet', {
        description: `tx ${result.txSignature.slice(0, 8)}…`,
      });
      router.push(`/rfps/${result.rfpPda}`);
    } catch (e) {
      toast.error('RFP create failed', { description: (e as Error).message });
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
              <SelectTrigger id="category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RFP_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scope_summary">Scope summary</Label>
            <Textarea
              id="scope_summary"
              rows={6}
              placeholder="What you need delivered, success criteria, exclusions, deadlines."
              {...form.register('scope_summary')}
            />
            {form.formState.errors.scope_summary && (
              <p className="text-xs text-destructive">
                {form.formState.errors.scope_summary.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="budget_max_usdc">Budget cap (USDC)</Label>
              <Input
                id="budget_max_usdc"
                type="text"
                inputMode="decimal"
                {...form.register('budget_max_usdc')}
              />
              {form.formState.errors.budget_max_usdc && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.budget_max_usdc.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bid_window_hours">Bid window (hours)</Label>
              <Input
                id="bid_window_hours"
                type="number"
                min={1}
                max={336}
                {...form.register('bid_window_hours', { valueAsNumber: true })}
              />
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
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="milestone_count">Milestones</Label>
            <Input
              id="milestone_count"
              type="number"
              min={1}
              max={8}
              {...form.register('milestone_count', { valueAsNumber: true })}
            />
            <p className="text-xs text-muted-foreground">
              Even-split percentages for v1; per-milestone customization arrives in the escrow-fund
              flow.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        {stage && <span className="text-xs text-muted-foreground">{STAGE_LABEL[stage]}</span>}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Posting…' : 'Post RFP'}
        </Button>
      </div>
    </form>
  );
}
