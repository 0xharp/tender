'use client';

import { AwardConfirmDialog, type AwardConfirmPayload } from '@/components/escrow/confirm-dialogs';
import { HashLink } from '@/components/primitives/hash-link';
import { PrivacyTag } from '@/components/primitives/privacy-tag';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type BuyerRevealStage,
  type DecryptedBid,
  revealAllBidsForBuyer,
} from '@/lib/bids/buyer-reveal-flow';
import { friendlyBidError } from '@/lib/bids/error-utils';
import type { DerivedRfpKeypair } from '@/lib/crypto/derive-rfp-keypair';
import { cn } from '@/lib/utils';
import type { Address } from '@solana/kit';
/**
 * Buyer-side bid comparison + selection panel. Lives inside `AwardSection`.
 *
 * Click "Decrypt all bids" → batch-call `open_reveal_window` for any bid that
 * the buyer doesn't yet have PER read access to (1 popup), then derive buyer's
 * X25519 key (1 popup) + TEE auth (1 popup), fetch + decrypt every envelope.
 * After the first decryption pass, the panel renders a sortable comparison
 * row per bid: price, timeline, scope, milestones, payout address.
 *
 * "Pick this bid" calls back to the AwardSection with everything it needs to
 * fire `select_bid + fund_project` - no manual paste required.
 */
import { useSelectedWalletAccount, useSignMessage, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  SparklesIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export interface BidPicked {
  bidPda: string;
  /** For public bids: bid.provider == main wallet. For private: decrypted from
   *  `_bidBinding.mainWallet`. */
  winnerProviderWallet: string;
  /** The on-chain bid signer (== bid.provider). Differs from winnerProvider in
   *  private mode (ephemeral wallet). */
  bidSignerWallet: string;
  /** Required when bidSignerWallet != winnerProviderWallet - base64 ed25519
   *  signature over the canonical binding message. */
  bidBindingSignatureBase64?: string;
  contractValueUsdc: string;
  /** Per-milestone USDC amounts in bid-defined order. Sum equals contractValueUsdc. */
  milestoneAmounts: string[];
  /** Per-milestone delivery duration in days. 0 = no deadline. Same order. */
  milestoneDurationsDays: number[];
}

export interface BuyerBidDecryptionPanelProps {
  rfpPda: Address;
  rfpNonceHex: string;
  bidPdas: Address[];
  /** Platform fee in basis points; sourced from on-chain rfp.fee_bps. Used in
   *  the award confirmation dialog to show the net the provider receives. */
  feeBps: number;
  /** Fires when the buyer commits to award a specific bid. The parent runs
   *  the select_bid + fund_project flow. */
  onAward: (bid: BidPicked) => Promise<void>;
  /** While the parent's award flow is running, freeze all rows. */
  awarding?: boolean;
  /** PDA of the bid currently being awarded (for spinner state). */
  awardingBidPda?: string;
}

type SortBy = 'price' | 'timeline' | 'submitted';

// Friendly labels for each decrypt stage. We hand-write these instead of
// snake-case → sentence-case conversion so awkward terms ("authenticating_er",
// "deriving_buyer_key") read naturally inside a disabled button.
const DECRYPT_STAGE_LABEL: Record<BuyerRevealStage, string> = {
  deriving_buyer_key: 'Deriving keypair…',
  authenticating_er: 'Authenticating with rollup…',
  fetching_bids: 'Fetching sealed bids…',
  opening_reveal_window: 'Opening reveal window…',
  decrypting: 'Decrypting envelopes…',
  done: 'Done…',
};

function decryptStageLabel(stage: BuyerRevealStage | null, fallback: string): string {
  if (!stage) return fallback;
  return DECRYPT_STAGE_LABEL[stage] ?? fallback;
}

export function BuyerBidDecryptionPanel(props: BuyerBidDecryptionPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  return <Connected account={account} {...props} />;
}

function Connected({
  account,
  rfpPda,
  rfpNonceHex,
  bidPdas,
  feeBps,
  onAward,
  awarding,
  awardingBidPda,
}: { account: UiWalletAccount } & BuyerBidDecryptionPanelProps) {
  const signMessage = useSignMessage(account);
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const [decrypting, setDecrypting] = useState(false);
  const [stage, setStage] = useState<BuyerRevealStage | null>(null);
  const [bids, setBids] = useState<DecryptedBid[]>([]);
  const [cachedBuyerKp, setCachedBuyerKp] = useState<DerivedRfpKeypair | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('price');
  const [sortAsc, setSortAsc] = useState(true);
  // Award confirmation dialog state. We hold the BidPicked payload here while
  // the dialog is open; on Confirm we call props.onAward with it.
  const [pendingAward, setPendingAward] = useState<{
    picked: BidPicked;
    confirm: AwardConfirmPayload;
  } | null>(null);

  async function handleDecrypt() {
    setDecrypting(true);
    setStage(null);
    try {
      const result = await revealAllBidsForBuyer({
        buyerWallet: account.address as Address,
        rfpPda,
        rfpNonceHex,
        bidPdas,
        // biome-ignore lint/suspicious/noExplicitAny: hook narrowing
        signMessage: signMessage as any,
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook return shape
        signTransactions: signTransactions as any,
        cachedBuyerKp: cachedBuyerKp ?? undefined,
        // We intentionally drop the `detail` (e.g., "3 bid(s)") here - the
        // panel keeps a fixed-width button, so any text that grows mid-flow
        // would cause layout jitter. The headline stage is enough.
        onProgress: (s) => setStage(s),
      });
      setBids(result.bids);
      setCachedBuyerKp(result.buyerKp);
      const ok = result.bids.filter((b) => b.plaintext).length;
      const fail = result.bids.length - ok;
      toast.success(`Decrypted ${ok} bid${ok === 1 ? '' : 's'}`, {
        description: fail > 0 ? `${fail} failed - see panel for per-bid errors.` : undefined,
      });
    } catch (e) {
      toast.error('Decrypt failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setDecrypting(false);
      setStage(null);
    }
  }

  const sortedBids = [...bids].sort((a, b) => {
    const av = sortValue(a, sortBy);
    const bv = sortValue(b, sortBy);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortAsc ? av - bv : bv - av;
  });

  function toggleSort(key: SortBy) {
    if (sortBy === key) setSortAsc((v) => !v);
    else {
      setSortBy(key);
      setSortAsc(true);
    }
  }

  if (bids.length === 0) {
    return (
      <Card className="border-dashed border-border/60">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LockKeyholeIcon className="size-4 text-muted-foreground" />
            Decrypt incoming bids
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            {bidPdas.length} sealed bid{bidPdas.length === 1 ? '' : 's'} on this RFP. Click to
            derive your X25519 key, grant yourself PER read access for any bid that hasn't opened
            yet, and decrypt every envelope in your browser.
          </p>
          <div className="flex flex-col items-end gap-2">
            <Button
              type="button"
              disabled={decrypting || bidPdas.length === 0}
              onClick={handleDecrypt}
              className="min-w-[14rem] justify-center"
            >
              <KeyRoundIcon className="size-3.5" />
              {decrypting
                ? decryptStageLabel(stage, 'Decrypting…')
                : `Decrypt ${bidPdas.length} bid${bidPdas.length === 1 ? '' : 's'}`}
            </Button>
            <p className="text-[10px] text-muted-foreground">
              2–3 wallet popups; instant on subsequent runs.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-card via-card to-primary/5">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <SparklesIcon className="size-4 text-primary" />
          {bids.length} bid{bids.length === 1 ? '' : 's'} decrypted
        </CardTitle>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Sort:</span>
          <SortButton
            active={sortBy === 'price'}
            asc={sortAsc}
            label="Price"
            onClick={() => toggleSort('price')}
          />
          <SortButton
            active={sortBy === 'timeline'}
            asc={sortAsc}
            label="Timeline"
            onClick={() => toggleSort('timeline')}
          />
          <SortButton
            active={sortBy === 'submitted'}
            asc={sortAsc}
            label="Submitted"
            onClick={() => toggleSort('submitted')}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sortedBids.map((b) => (
          <BidRow
            key={b.bidPda}
            bid={b}
            awarding={!!awarding && awardingBidPda === b.bidPda}
            disabled={!!awarding}
            onAward={() => {
              if (!b.plaintext) return;
              const picked: BidPicked = {
                bidPda: b.bidPda,
                winnerProviderWallet: b.mainWallet ?? b.bidSignerWallet,
                bidSignerWallet: b.bidSignerWallet,
                bidBindingSignatureBase64: b.bindingSignatureBase64,
                contractValueUsdc: b.plaintext.priceUsdc,
                milestoneAmounts: b.plaintext.milestones.map((m) => m.amountUsdc),
                milestoneDurationsDays: b.plaintext.milestones.map((m) => m.durationDays),
              };
              setPendingAward({
                picked,
                confirm: {
                  bidPda: b.bidPda,
                  contractValueUsdc: b.plaintext.priceUsdc,
                  milestones: b.plaintext.milestones.map((m) => ({
                    name: m.name,
                    amountUsdc: m.amountUsdc,
                  })),
                  payoutWallet: b.plaintext.payoutPreference.address,
                  bidSignerWallet: b.bidSignerWallet,
                  isPrivate: b.isPrivate,
                  feeBps,
                },
              });
            }}
          />
        ))}
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={decrypting || awarding}
            onClick={handleDecrypt}
            className="min-w-[12rem] justify-center text-xs"
          >
            {decrypting ? decryptStageLabel(stage, 'Re-decrypting…') : 'Re-decrypt (refresh)'}
          </Button>
        </div>
      </CardContent>

      <AwardConfirmDialog
        open={pendingAward !== null}
        onOpenChange={(o) => {
          if (!o) setPendingAward(null);
        }}
        pending={pendingAward?.confirm ?? null}
        busy={!!awarding}
        onConfirm={async () => {
          if (!pendingAward) return;
          const picked = pendingAward.picked;
          // Close the dialog immediately so the buyer sees the award progress
          // status on the bid row instead of staring at a stale modal.
          setPendingAward(null);
          await onAward(picked);
        }}
      />
    </Card>
  );
}

function BidRow({
  bid,
  awarding,
  disabled,
  onAward,
}: {
  bid: DecryptedBid;
  awarding: boolean;
  disabled: boolean;
  onAward: () => void | Promise<void>;
}) {
  if (bid.error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <div className="font-mono text-muted-foreground">
          bid <HashLink hash={bid.bidPda} kind="account" visibleChars={6} />
        </div>
        <p className="mt-1 text-destructive">{bid.error}</p>
      </div>
    );
  }
  const pt = bid.plaintext!;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 transition-colors',
        awarding
          ? 'border-emerald-500/40 bg-emerald-500/5 shadow-sm shadow-emerald-500/10'
          : 'border-border/60 bg-card/40 hover:border-border',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            bid · <HashLink hash={bid.bidPda} kind="account" visibleChars={6} />
            <PrivacyTag mode={bid.isPrivate ? 'buyer_only' : 'public'} size="sm" iconless />
          </div>
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-2xl font-semibold tabular-nums">
              ${Number(pt.priceUsdc).toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">
              · {pt.timelineDays} day{pt.timelineDays === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={onAward}
          className="rounded-full"
          title={`Lock $${Number(pt.priceUsdc).toLocaleString()} USDC into escrow + record this bid as the winner`}
        >
          {awarding ? 'Awarding…' : 'Award winner and lock funds'}
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-foreground/80 line-clamp-3">{pt.scope}</p>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Milestones · {pt.milestones.length}
        </span>
        <ul className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 bg-card/30 p-2.5">
          {pt.milestones.map((m, i) => (
            <li key={`${bid.bidPda}-${i}`} className="flex flex-col gap-1 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span>
                  <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>{' '}
                  {m.name}
                </span>
                <span className="font-mono tabular-nums">
                  ${Number(m.amountUsdc).toLocaleString()}
                </span>
              </div>
              {m.successCriteria && (
                <p className="rounded border border-primary/15 bg-primary/5 px-2 py-1 text-[10px] leading-relaxed text-foreground/75">
                  <span className="font-medium text-primary/80">Acceptance bar:</span>{' '}
                  {m.successCriteria}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>
            payout · <HashLink hash={pt.payoutPreference.address} kind="account" visibleChars={4} />
          </span>
          {bid.isPrivate && bid.mainWallet && (
            <span>
              main · <HashLink hash={bid.mainWallet} kind="account" visibleChars={4} />
            </span>
          )}
          <span>
            signer · <HashLink hash={bid.bidSignerWallet} kind="account" visibleChars={4} />
          </span>
        </div>
        {pt.notes && (
          <span className="italic line-clamp-1 max-w-[260px]" title={pt.notes}>
            {pt.notes}
          </span>
        )}
      </div>
    </div>
  );
}

function SortButton({
  active,
  asc,
  label,
  onClick,
}: { active: boolean; asc: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors',
        active
          ? 'border border-primary/40 bg-primary/10 text-primary'
          : 'border border-border/60 text-muted-foreground hover:bg-card',
      )}
    >
      {label}
      {active && (asc ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
    </button>
  );
}

function sortValue(b: DecryptedBid, key: SortBy): number | null {
  if (b.error || !b.plaintext) return null;
  if (key === 'price') return Number(b.plaintext.priceUsdc);
  if (key === 'timeline') return b.plaintext.timelineDays;
  return null; // submitted: needs caller to provide; not in DecryptedBid yet
}
