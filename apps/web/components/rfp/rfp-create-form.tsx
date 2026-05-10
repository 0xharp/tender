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

import { isAiAvailable } from '@/lib/ai';
import { SparklesIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { AiDraftModal } from '@/components/ai/ai-draft-modal';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MarkdownEditor } from '@/components/ui/markdown-editor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { friendlyBidError } from '@/lib/bids/error-utils';
import { scrollToFirstError } from '@/lib/forms/scroll-to-error';
import {
  type PrivateCreateStage,
  type SubmitStage,
  submitRfpCreate,
  submitRfpCreatePrivate,
} from '@/lib/rfps/create-flow';
import { RFP_CATEGORIES, type RfpFormValues, rfpFormSchema } from '@/lib/rfps/schema';
import { rpc, rpcSubscriptions } from '@/lib/solana/client';

function CharCounter({
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

const STAGE_LABEL: Record<SubmitStage, string> = {
  deriving_keypair: 'Sign the encryption-key derivation message…',
  building_tx: 'Building the on-chain transaction…',
  awaiting_signature: 'Approve the transaction in your wallet…',
  confirming_tx: 'Waiting for devnet confirmation…',
  saving_metadata: 'Saving RFP metadata…',
};

const PRIVATE_CREATE_STAGE_LABEL: Record<PrivateCreateStage, string> = {
  unlocking_keychain: 'Sign once to unlock your private buyer keychain…',
  allocating_slot: 'Preparing your private buyer wallet…',
  cloak_funding_ephemeral: "Routing SOL through Cloak's shielded pool…",
  building_tx: 'Building the create-RFP transaction…',
  signing_locally: 'Signing the transaction…',
  confirming_tx: 'Waiting for devnet confirmation…',
  saving_metadata: 'Saving RFP metadata…',
  done: 'Done',
};

// Rough per-stage time estimates in seconds. Cloak ALT setup dominates;
// the rest is sub-5s wallet/RPC work. Used to derive a "~Xs left"
// hint so the user knows the private path is intentionally slow, not
// stuck. Numbers tuned from observed devnet timings.
const PRIVATE_STAGE_SECONDS: Record<PrivateCreateStage, number> = {
  unlocking_keychain: 3,
  allocating_slot: 2,
  cloak_funding_ephemeral: 18,
  building_tx: 1,
  signing_locally: 1,
  confirming_tx: 10,
  saving_metadata: 2,
  done: 0,
};

const PRIVATE_STAGE_ORDER: PrivateCreateStage[] = [
  'unlocking_keychain',
  'allocating_slot',
  'cloak_funding_ephemeral',
  'building_tx',
  'signing_locally',
  'confirming_tx',
  'saving_metadata',
  'done',
];

const PRIVATE_TOTAL_SECONDS = PRIVATE_STAGE_ORDER.reduce(
  (acc, s) => acc + PRIVATE_STAGE_SECONDS[s],
  0,
);

function PrivateCreateProgress({ stage }: { stage: PrivateCreateStage }) {
  const idx = PRIVATE_STAGE_ORDER.indexOf(stage);
  const elapsedSecs = PRIVATE_STAGE_ORDER.slice(0, idx).reduce(
    (acc, s) => acc + PRIVATE_STAGE_SECONDS[s],
    0,
  );
  const remainingSecs = Math.max(0, PRIVATE_TOTAL_SECONDS - elapsedSecs);
  const pct = Math.min(100, Math.round((elapsedSecs / PRIVATE_TOTAL_SECONDS) * 100));
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-primary/20 bg-primary/[0.03] p-3">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-2 text-foreground">
          <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
          {PRIVATE_CREATE_STAGE_LABEL[stage]}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">
          step {Math.min(idx + 1, PRIVATE_STAGE_ORDER.length - 1)} of{' '}
          {PRIVATE_STAGE_ORDER.length - 1} · ~{remainingSecs}s left
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

export function RfpCreateForm() {
  const account = useTendrAccount();

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

function ConnectedForm({ account }: { account: TendrAccount }) {
  const signMessage = useTendrSignMessage(account);
  const signTransactions = useTendrSignTransactions(account);
  // Shared HD keychain — required by the private-create path so the
  // session's master seed is reused across forms instead of triggering
  // a fresh popup every time the user toggles between surfaces.
  const keychain = useKeychainContext();
  const router = useRouter();
  const [stage, setStage] = useState<SubmitStage | null>(null);
  const [privateStage, setPrivateStage] = useState<PrivateCreateStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

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
      // No preselection — force the user to make an explicit choice
      // about treasury privacy. Was 'public' which let users miss the
      // anonymous-buyer mode entirely.
      // biome-ignore lint/suspicious/noExplicitAny: zod default vs RHF Resolver type drift
      buyer_visibility: '' as any,
    },
  });

  async function onSubmit(values: RfpFormValues) {
    setSubmitting(true);
    setStage(null);
    setPrivateStage(null);
    try {
      if (values.buyer_visibility === 'private') {
        if (!keychain) {
          toast.error('Connect a wallet first to unlock private mode');
          return;
        }
        // v2 anonymous-buyer mode. create_rfp is signed by an HD-derived
        // ephemeral whose SOL rent comes from Cloak's shielded pool.
        // The buyer's main wallet leaves no on-chain footprint — the
        // only link is the Cloak deposit, which the shielded pool
        // breaks via the UTXO + ZK-proof model.
        const result = await submitRfpCreatePrivate({
          // biome-ignore lint/suspicious/noExplicitAny: brand-only conversion
          wallet: account.address as any,
          values,
          signMessage,
          // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
          signTransactions: signTransactions as any,
          keychain,
          rpc,
          rpcSubscriptions,
          onProgress: setPrivateStage,
        });
        toast.success('RFP posted to devnet', {
          description: <TxToastDescription hash={result.txSignature} prefix="Tx" />,
          duration: 8000,
        });
        triggerActivityRefresh();
        router.push(`/rfps/${result.rfpPda}`);
        return;
      }

      // Public-buyer mode (today's path).
      const result = await submitRfpCreate({
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
      triggerActivityRefresh();
      router.push(`/rfps/${result.rfpPda}`);
    } catch (e) {
      toast.error('RFP create failed', { description: friendlyBidError(e) });
    } finally {
      setSubmitting(false);
      setStage(null);
      setPrivateStage(null);
    }
  }

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit, scrollToFirstError)}
      className="flex flex-col gap-6"
    >
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
            <div className="flex items-baseline justify-between gap-3">
              <Label htmlFor="scope_summary">Scope summary</Label>
              {/* AI draft trigger — only renders when QVAC sidecar URL is
                  configured. Opens a modal where the buyer types a plain-
                  English description; modal calls the sidecar directly
                  (browser → Nosana, no Tendr backend hop) + drops the
                  generated scope into this textarea on accept. */}
              {isAiAvailable() && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto gap-1.5 px-2 py-1 text-xs text-primary hover:bg-primary/10"
                  onClick={() => setAiOpen(true)}
                >
                  <SparklesIcon className="size-3.5" />
                  Draft with QVAC Private AI
                </Button>
              )}
            </div>
            {/* MarkdownEditor instead of plain Textarea — AI-drafted scopes
                arrive as markdown, and we render markdown on the RFP detail
                page. Tabbed Edit/Preview lets the buyer verify formatting
                before posting. RHF.register doesn't compose with this
                component (custom value/onChange API), so we read/write via
                watch + setValue. shouldDirty/shouldTouch keep the form
                state honest for validation + submit-button enabling. */}
            <MarkdownEditor
              id="scope_summary"
              rows={6}
              placeholder="What you need delivered, success criteria, exclusions, deadlines. Markdown supported."
              value={form.watch('scope_summary') ?? ''}
              onChange={(text) =>
                form.setValue('scope_summary', text, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: true,
                })
              }
              ariaInvalid={!!form.formState.errors.scope_summary}
            />
            <CharCounter
              value={form.watch('scope_summary') ?? ''}
              min={20}
              max={4000}
              hint="markdown source"
            />
            {form.formState.errors.scope_summary && (
              <p className="text-xs text-destructive">
                {form.formState.errors.scope_summary.message}
              </p>
            )}
          </div>

          <AiDraftModal
            open={aiOpen}
            onOpenChange={setAiOpen}
            mode={{
              kind: 'rfp-scope',
              category: form.watch('category'),
              // Intentionally NO budgetUsdc here. The reserve_price_usdc
              // field is sealed on chain; passing it to the AI risks the
              // model echoing the number into the public scope summary.
              // See lib/ai/prompts.ts CRITICAL PRIVACY RULE.
              timelineDays: form.watch('bid_window_hours')
                ? Math.ceil(Number(form.watch('bid_window_hours')) / 24)
                : undefined,
              onAccept: (text) => {
                form.setValue('scope_summary', text, {
                  shouldValidate: true,
                  shouldDirty: true,
                });
              },
            }}
          />

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bid_window_hours">Bid window (hours)</Label>
              <Input
                id="bid_window_hours"
                type="number"
                min={0.5}
                max={336}
                step={0.5}
                {...form.register('bid_window_hours', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                How long providers can submit sealed bids. Min 0.5 (30 min).
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reveal_window_hours">Reveal window (hours)</Label>
              <Input
                id="reveal_window_hours"
                type="number"
                min={0.5}
                max={336}
                step={0.5}
                {...form.register('reveal_window_hours', { valueAsNumber: true })}
              />
              <p className="text-xs text-muted-foreground">
                How long you have to review + award after bidding closes. Min 0.5 (30 min).
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
              Bid contents are always sealed until the bid window closes - even from you.
            </p>
            <p className="mt-1 text-muted-foreground">
              Enforced cryptographically by the{' '}
              <strong className="font-medium text-primary">MagicBlock</strong> TEE-backed validator,
              not by policy. Once bidding closes, you decrypt bids in your browser (one wallet
              signature) to evaluate them, then award the winner. The two choices below add
              orthogonal privacy layers: keep <em>bidder</em> identities anonymous, and/or run as an{' '}
              <em>anonymous buyer</em> so your treasury wallet stays off-chain through funding via
              Cloak's shielded pool.{' '}
              <a
                href="/docs/privacy-model"
                className="underline underline-offset-2 hover:text-primary"
              >
                Read the model →
              </a>
            </p>
          </div>

          {/* Anchor id matches the field name so scrollToFirstError can
              find the fieldset when nothing is selected. The radio
              `<input>`s have name="bidder_visibility" but they're stacked
              inside a centered fieldset; scrolling to the first one would
              still leave the legend offscreen on smaller viewports. No
              red ring here — it cut through the legend text on small
              viewports; the inline `<p className="text-destructive">`
              below the radios carries the error signal instead. */}
          <fieldset
            id="bidder_visibility"
            className="flex flex-col gap-2.5"
            aria-describedby="visibility-help"
            aria-invalid={!!form.formState.errors.bidder_visibility}
          >
            <legend className="mb-1 text-sm font-medium">Bidder privacy mode</legend>
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
                  Same content sealing, plus each bid is signed by a fresh ephemeral wallet derived
                  from the provider's HD keychain (one bidder ephemeral per bid index). The
                  ephemeral pubkey is the only on-chain identity; nothing links it back to the
                  provider's main wallet until they win and Claim reputation from Dashboard. Losers
                  stay anonymous forever.
                </span>
              </span>
            </label>
            {form.formState.errors.bidder_visibility && (
              <p className="text-xs text-destructive">
                {form.formState.errors.bidder_visibility.message ??
                  'Pick a bidder privacy mode to continue.'}
              </p>
            )}
          </fieldset>

          {/* v2: orthogonal axis — buyer-side privacy. Public = main wallet
              on-chain (today's behavior); Private = HD-derived ephemeral
              hides treasury identity + funding trail. The two pair up to
              four user-visible modes, with "fully sealed" (both private)
              as the strongest privacy posture. */}
          <fieldset
            id="buyer_visibility"
            className="flex flex-col gap-2.5"
            aria-describedby="buyer-visibility-help"
            aria-invalid={!!form.formState.errors.buyer_visibility}
          >
            <legend className="mb-1 text-sm font-medium">Buyer privacy mode</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
              <input
                type="radio"
                value="public"
                {...form.register('buyer_visibility')}
                className="mt-0.5 size-4 cursor-pointer accent-primary"
              />
              <span className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Public buyer</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Your main wallet appears as the RFP's buyer on-chain. Buyer reputation (RFPs
                  created, funded, completed) accumulates as you transact. Everyone evaluating
                  providers can see your track record.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-card/40 p-3 transition-colors has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
              <input
                type="radio"
                value="private"
                {...form.register('buyer_visibility')}
                className="mt-0.5 size-4 cursor-pointer accent-primary"
              />
              <span className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Anonymous buyer</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  RFP is created via an ephemeral wallet derived from your HD keychain. Treasury
                  identity stays off-chain throughout the lifecycle and funding goes through Cloak's
                  shielded pool. Public buyer reputation does NOT accumulate unless you later Claim
                  reputation from Dashboard once the RFP completes. Pair with "Bid contents + bidder
                  identity private" above for the fully-sealed posture.
                </span>
                <span className="rounded-md border border-fuchsia-500/20 bg-fuchsia-500/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground/80">
                  <span className="font-medium text-fuchsia-700 dark:text-fuchsia-300">
                    ~0.06 SOL via Cloak
                  </span>{' '}
                  funds the ephemeral signer once at creation. It pays for every privacy-preserving
                  signature you'll make on this RFP (close, award, accept, refund) so your main
                  wallet never appears as a tx fee payer. Unused SOL refundable anytime from
                  Dashboard via Ephemeral Sweep.
                </span>
              </span>
            </label>
            {form.formState.errors.buyer_visibility && (
              <p className="text-xs text-destructive">
                {form.formState.errors.buyer_visibility.message ??
                  'Pick a buyer privacy mode to continue.'}
              </p>
            )}
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
        {privateStage && <PrivateCreateProgress stage={privateStage} />}
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
