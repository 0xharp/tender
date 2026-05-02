'use client';

import type { Address } from '@solana/kit';
/**
 * Buyer-side action panel rendered on the RFP detail page.
 *
 * Surfaces only the relevant actions for the current RFP/milestone state.
 * Designed to be the buyer's single workspace for managing a project
 * end-to-end: award + fund the winner, then accept / request changes /
 * reject / cancel each milestone as it comes in.
 *
 * UX bar: every action has its consequence (amount, recipient, irreversibility,
 * reputation impact) shown BEFORE the wallet popup.
 */
import { useSelectedWalletAccount, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useState } from 'react';
import { toast } from 'sonner';

import {
  type BidPicked,
  BuyerBidDecryptionPanel,
} from '@/components/escrow/buyer-bid-decryption-panel';
import {
  CancelMilestoneDialog,
  type CancelMilestonePayload,
} from '@/components/escrow/confirm-dialogs';
import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type CloseBiddingStage, closeBidding } from '@/lib/bids/close-bidding-flow';
import { friendlyBidError, humanizeStage } from '@/lib/bids/error-utils';
import { type AwardStage, awardAndFund } from '@/lib/escrow/award-fund-flow';
import {
  acceptMilestone,
  cancelLateMilestone,
  cancelWithNotice,
  cancelWithPenalty,
  disputeDefaultSplit,
  markBuyerGhosted,
  proposeDisputeSplit,
  rejectMilestone,
  requestChanges,
} from '@/lib/escrow/milestone-flow';
import { rpc } from '@/lib/solana/client';

const AWARD_STAGE_LABEL: Record<AwardStage, string> = {
  building_txs: 'Building transactions…',
  awaiting_signature: 'Approve all transactions in your wallet (single popup)…',
  sending_reveal: 'Revealing the sealed reserve price on-chain…',
  sending_select: 'Recording the winner on-chain…',
  sending_fund: 'Locking USDC into escrow + initializing milestones…',
  done: 'Done.',
};

/** Circle's devnet USDC mint. */
const DEVNET_MOCK_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;

export interface MilestoneSummary {
  index: number;
  amount: bigint;
  status: string; // milestoneStatusToString
  iterationCount: number;
  reviewDeadlineIso: string | null;
  disputeDeadlineIso: string | null;
  /** Provider's promised delivery deadline (set in start_milestone from rfp
   *  duration). Null if no deadline configured for this milestone (legacy
   *  bid or duration_days = 0). */
  deliveryDeadlineIso: string | null;
  buyerProposedSplitBps: number; // 0xFFFF = not proposed
  providerProposedSplitBps: number;
}

export interface BuyerActionPanelProps {
  rfpPda: string;
  rfpStatus: string; // 'open' | 'reveal' | 'awarded' | 'funded' | 'inprogress' | 'completed' | 'cancelled' | ...
  /** Off-chain rfp_nonce_hex from supabase - needed to derive the buyer's
   *  X25519 keypair for envelope decryption. */
  rfpNonceHex: string;
  /** On-chain rfp.fee_bps - locked per-RFP. Drives the award confirmation
   *  dialog's net-payout breakdown. */
  feeBps: number;
  contractValueUsdc: string;
  /** On-chain rfp.contract_value (USDC base units). Used by ResumeFundingSection
   *  to retry fund_project after select_bid landed but fund failed. */
  contractValueRaw: bigint;
  /** On-chain rfp.milestone_count - 0 pre-award, 1..8 once select_bid lands.
   *  Drives the milestone PDAs needed by fund_project's remaining accounts. */
  milestoneCount: number;
  /** Per-milestone payout amounts (USDC base units), sliced to milestone_count. */
  milestoneAmounts: bigint[];
  /** Per-milestone delivery duration (seconds), sliced to milestone_count.
   *  0 entry = no deadline. */
  milestoneDurationsSecs: bigint[];
  /** On-chain rfp.winner (BidCommit PDA) - populated post select_bid. */
  winnerBidPda: string | null;
  fundingDeadlineIso: string | null;
  milestones: MilestoneSummary[];
  winnerProvider: string | null;
  /** Encrypted bids list (provider attestations + commit_hash). For buyer to pick winner. */
  bids: { address: string; commitHashHex: string; submittedAtIso: string }[];
  /** Server computed: is now past bid_close_at? Drives the "Close bidding"
   *  button visibility when status is still Open. */
  isPastBidClose: boolean;
}

export function BuyerActionPanel(props: BuyerActionPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  return <ConnectedBuyerPanel account={account} {...props} />;
}

function ConnectedBuyerPanel({
  account,
  rfpPda,
  rfpStatus,
  rfpNonceHex,
  feeBps,
  contractValueUsdc,
  contractValueRaw,
  milestoneAmounts,
  milestoneDurationsSecs,
  winnerBidPda,
  fundingDeadlineIso,
  milestones,
  winnerProvider,
  bids,
  isPastBidClose,
}: BuyerActionPanelProps & { account: UiWalletAccount }) {
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const wallet = account.address as Address;

  /* ----- CLOSE BIDDING (Open + past bid_close_at) ------------------------ */

  if (rfpStatus === 'open' && isPastBidClose) {
    return (
      <CloseBiddingSection
        wallet={wallet}
        rfpPda={rfpPda as Address}
        bidCount={bids.length}
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard
        signTransactions={signTransactions as any}
      />
    );
  }

  /* ----- AWARD + FUND ----------------------------------------------------- */

  if (rfpStatus === 'reveal' || rfpStatus === 'bidsclosed') {
    return (
      <AwardSection
        wallet={wallet}
        rfpPda={rfpPda as Address}
        rfpNonceHex={rfpNonceHex}
        feeBps={feeBps}
        bids={bids}
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook type drift
        signTransactions={signTransactions as any}
      />
    );
  }

  /* ----- BUYER GHOSTED CHECK --------------------------------------------- */

  if (rfpStatus === 'awarded') {
    const expired = fundingDeadlineIso && new Date(fundingDeadlineIso).getTime() < Date.now();
    if (expired) {
      return (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base">Funding deadline missed</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p>
              The funding window expired without you funding the project. The provider can now mark
              this RFP as ghosted, which will increment your ghost-count on-chain.
            </p>
            <p className="text-muted-foreground">
              Anyone may call <code>mark_buyer_ghosted</code> permissionlessly.
            </p>
          </CardContent>
        </Card>
      );
    }
    return (
      <ResumeFundingSection
        wallet={wallet}
        rfpPda={rfpPda as Address}
        winnerBidPda={winnerBidPda}
        winnerProvider={winnerProvider}
        contractValueRaw={contractValueRaw}
        contractValueUsdc={contractValueUsdc}
        milestoneAmounts={milestoneAmounts}
        milestoneDurationsSecs={milestoneDurationsSecs}
        // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
        signTransactions={signTransactions as any}
      />
    );
  }

  /* ----- MILESTONE MANAGEMENT (post-fund) -------------------------------- */

  if (rfpStatus === 'funded' || rfpStatus === 'inprogress' || rfpStatus === 'disputed') {
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3">
          <CardTitle className="text-base">Project - milestone management</CardTitle>
          <span className="font-mono text-xs text-muted-foreground">
            {contractValueUsdc} USDC locked
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {milestones.map((ms) => (
            <BuyerMilestoneRow
              key={ms.index}
              wallet={wallet}
              rfpPda={rfpPda as Address}
              milestone={ms}
              winnerProvider={winnerProvider as Address | null}
              // biome-ignore lint/suspicious/noExplicitAny: hook type drift
              signTransactions={signTransactions as any}
            />
          ))}
        </CardContent>
      </Card>
    );
  }

  /* ----- COMPLETED / CANCELLED ------------------------------------------- */

  if (rfpStatus === 'completed') {
    return (
      <Card className="border-emerald-500/40 bg-emerald-500/5">
        <CardHeader>
          <CardTitle className="text-base">Project completed</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Every milestone has been released or cancelled. Total contract value:{' '}
            <span className="font-mono text-foreground">{contractValueUsdc} USDC</span>.
          </p>
        </CardContent>
      </Card>
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* AwardSection - pick winner + reveal reserve + fund                         */
/* -------------------------------------------------------------------------- */

function AwardSection({
  wallet,
  rfpPda,
  rfpNonceHex,
  feeBps,
  bids,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  rfpNonceHex: string;
  feeBps: number;
  bids: { address: string; commitHashHex: string; submittedAtIso: string }[];
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard
  signTransactions: any;
}) {
  const [stage, setStage] = useState<AwardStage | null>(null);
  const [awarding, setAwarding] = useState(false);
  const [awardingBidPda, setAwardingBidPda] = useState<string | null>(null);
  const [done, setDone] = useState<{ select: string; fund: string; reveal?: string } | null>(null);
  const [reserveReveal, setReserveReveal] = useState<{ amount: string; nonceHex: string } | null>(
    null,
  );

  // Auto-load reserve reveal material from localStorage (saved at create time).
  if (typeof window !== 'undefined' && reserveReveal === null) {
    const stored = window.localStorage.getItem(`tender:reserve:${rfpPda}`);
    if (stored) {
      try {
        const j = JSON.parse(stored) as { amount: string; nonce: string };
        setReserveReveal({ amount: j.amount, nonceHex: j.nonce });
      } catch {
        /* ignore */
      }
    } else {
      setReserveReveal({ amount: '', nonceHex: '' });
    }
  }

  async function handleAward(picked: BidPicked) {
    setAwarding(true);
    setAwardingBidPda(picked.bidPda);
    setStage(null);
    try {
      // Convert decrypted decimal-USDC milestone strings to base units (bigint).
      // The flow re-validates that they sum to contractValue downstream.
      const milestoneAmounts = picked.milestoneAmounts.map((s) => usdcToBaseUnits(s));
      if (milestoneAmounts.some((a) => a <= 0n)) {
        throw new Error('Decrypted milestone amounts include a non-positive value.');
      }
      const milestoneDurationsSecs = picked.milestoneDurationsDays.map((d) => BigInt(d * 86400));

      const result = await awardAndFund({
        buyer: wallet,
        rfpPda,
        winnerBidPda: picked.bidPda as Address,
        winnerProviderWallet: picked.winnerProviderWallet as Address,
        bidSignerWallet: picked.bidSignerWallet as Address,
        bidBindingSignature: picked.bidBindingSignatureBase64
          ? Uint8Array.from(atob(picked.bidBindingSignatureBase64), (c) => c.charCodeAt(0))
          : undefined,
        contractValue: usdcToBaseUnits(picked.contractValueUsdc),
        mint: DEVNET_MOCK_USDC_MINT,
        reserveReveal: reserveReveal?.amount
          ? { amount: BigInt(reserveReveal.amount), nonceHex: reserveReveal.nonceHex }
          : undefined,
        milestoneAmounts,
        milestoneDurationsSecs,
        signTransactions,
        rpc,
        onProgress: setStage,
      });
      setDone({
        select: result.selectTxSignature,
        fund: result.fundTxSignature,
        reveal: result.revealTxSignature,
      });
      toast.success('Project awarded + funded', {
        description: `Locked $${Number(picked.contractValueUsdc).toLocaleString()} USDC into escrow.`,
      });
    } catch (e) {
      toast.error('Award + fund failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setAwarding(false);
      setAwardingBidPda(null);
      setStage(null);
    }
  }

  if (done) {
    return (
      <Card className="border-emerald-500/40 bg-emerald-500/5">
        <CardHeader>
          <CardTitle className="text-base">Project funded</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div>Provider can now start milestone 1.</div>
          {done.reveal && (
            <div className="font-mono text-xs">
              reveal: <HashLink hash={done.reveal} kind="tx" />
            </div>
          )}
          <div className="font-mono text-xs">
            select: <HashLink hash={done.select} kind="tx" />
          </div>
          <div className="font-mono text-xs">
            fund: <HashLink hash={done.fund} kind="tx" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="border-dashed border-primary/30 bg-primary/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Award the winner</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">Decrypt all bids below</strong>, compare them side
            by side, then click{' '}
            <strong className="text-foreground">Award winner and lock funds</strong> on the bid you
            want. You'll see a confirmation modal with the full breakdown - milestones, payout,
            fees, and exit options - before signing. One signature does the whole flow atomically:
            reveal the reserve (if set), record the winner on chain, and lock the contract value
            into escrow.
          </p>
          {reserveReveal?.amount && (
            <p className="text-amber-700 dark:text-amber-300">
              <strong>Reserve auto-loaded:</strong> $
              {(Number(reserveReveal.amount) / 1_000_000).toLocaleString()} USDC. Will be revealed
              on chain as part of the award tx.
            </p>
          )}
          {feeBps === 0 && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
              ⚠ This RFP reports <code>fee_bps = 0</code>. It was likely created against an older
              program deploy and its on-chain layout doesn't match the current schema. The award
              flow may produce wrong amounts. Create a fresh RFP for accurate testing.
            </p>
          )}
          {stage && (
            <span className="flex items-center gap-2 pt-1 text-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
              {AWARD_STAGE_LABEL[stage]}
            </span>
          )}
        </CardContent>
      </Card>

      <BuyerBidDecryptionPanel
        rfpPda={rfpPda}
        rfpNonceHex={rfpNonceHex}
        bidPdas={bids.map((b) => b.address as Address)}
        feeBps={feeBps}
        onAward={handleAward}
        awarding={awarding}
        awardingBidPda={awardingBidPda ?? undefined}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* CloseBiddingSection - buyer flips status Open → Reveal once bid window     */
/* expires. Required step before AwardSection appears.                         */
/* -------------------------------------------------------------------------- */

const CLOSE_BIDDING_STAGE_LABEL: Record<CloseBiddingStage, string> = {
  building: 'Building transaction…',
  awaiting_signature: 'Approve in your wallet…',
  sending: 'Sending to devnet…',
  confirming: 'Awaiting confirmation…',
};

function CloseBiddingSection({
  wallet,
  rfpPda,
  bidCount,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  bidCount: number;
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard
  signTransactions: any;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<CloseBiddingStage | null>(null);

  async function handleClose() {
    setBusy(true);
    try {
      const result = await closeBidding({
        buyer: wallet,
        rfpPda,
        signTransactions,
        rpc,
        onProgress: setStage,
      });
      toast.success('Bid window closed · status flipped to Reveal', {
        description: <TxToastDescription hash={result.txSignature} prefix="Tx" />,
        duration: 8000,
      });
      // Reload so the page re-renders with status=reveal → AwardSection appears.
      window.location.reload();
    } catch (e) {
      toast.error('Close bidding failed', { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <Card className="border-primary/40 bg-gradient-to-br from-card via-card to-primary/5">
      <CardHeader>
        <CardTitle className="text-base">Bid window has closed - flip to reveal phase</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3 text-xs leading-relaxed">
          <p className="font-medium text-foreground">
            {bidCount} sealed bid{bidCount === 1 ? '' : 's'} committed. Bidding is past the close
            time.
          </p>
          <p className="mt-1 text-muted-foreground">
            Flip the RFP to <strong className="text-foreground">Reveal</strong> to unlock the
            decrypt + award flow. Status change is on-chain (one tx). After this you'll see a panel
            to decrypt every bid in your browser, compare them side-by-side, and pick a winner.
          </p>
        </div>
        {stage && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
            {CLOSE_BIDDING_STAGE_LABEL[stage]}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={busy}
            onClick={handleClose}
            className="min-w-[14rem] rounded-full px-6"
          >
            {busy ? humanizeStage(stage, 'Closing') : 'Close bidding · begin reveal'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* ResumeFundingSection - shown when status=Awarded but fund_project never    */
/* landed (e.g., previous award attempt's fund tx hit a CU wall or the user   */
/* closed the tab between select_bid and fund_project). Re-invokes the same   */
/* awardAndFund flow; the flow's pre-flight reads on-chain status and skips   */
/* select_bid because it already succeeded, dispatching only fund_project.    */
/* -------------------------------------------------------------------------- */

function ResumeFundingSection({
  wallet,
  rfpPda,
  winnerBidPda,
  winnerProvider,
  contractValueRaw,
  contractValueUsdc,
  milestoneAmounts,
  milestoneDurationsSecs,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  winnerBidPda: string | null;
  winnerProvider: string | null;
  contractValueRaw: bigint;
  contractValueUsdc: string;
  milestoneAmounts: bigint[];
  milestoneDurationsSecs: bigint[];
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
  signTransactions: any;
}) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<AwardStage | null>(null);

  async function handleResume() {
    if (!winnerBidPda || !winnerProvider) {
      toast.error('Cannot resume - winner missing on-chain');
      return;
    }
    setBusy(true);
    try {
      const result = await awardAndFund({
        buyer: wallet,
        rfpPda,
        winnerBidPda: winnerBidPda as Address,
        // For resume we don't have the bid signer separately; the flow needs
        // it to detect private mode (winnerProvider != bidSigner). Since
        // select_bid is already past its gate, the flow's pre-flight skips
        // it and the bid-binding signature is never used. Pass winnerProvider
        // for both so isPrivateMode === false avoids the binding-sig check.
        winnerProviderWallet: winnerProvider as Address,
        bidSignerWallet: winnerProvider as Address,
        contractValue: contractValueRaw,
        mint: DEVNET_MOCK_USDC_MINT,
        // Reserve already revealed (or never set) by the prior award attempt
        // - re-revealing would hit InvalidRfpStatus.
        reserveReveal: undefined,
        milestoneAmounts,
        milestoneDurationsSecs,
        signTransactions,
        rpc,
        onProgress: setStage,
      });
      toast.success('Project funded', {
        description: <TxToastDescription hash={result.fundTxSignature} prefix="Tx" />,
        duration: 8000,
      });
      window.location.reload();
    } catch (e) {
      toast.error('Resume funding failed', {
        description: friendlyBidError(e),
        duration: 12000,
      });
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-base">Awarded - resume funding</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
          <p className="font-medium text-amber-700 dark:text-amber-300">
            The winner is recorded on-chain but the escrow hasn&rsquo;t been funded yet.
          </p>
          <p className="mt-1 text-muted-foreground">
            This usually means the previous award attempt&rsquo;s fund step failed (closed tab,
            compute-budget, network blip). One click below replays only the funding tx -
            <code className="mx-0.5">${contractValueUsdc}</code> USDC will move into per-milestone
            escrow.
          </p>
        </div>
        {stage && (
          <span className="flex items-center gap-2 pt-1 text-xs text-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_8px] shadow-primary/60" />
            {AWARD_STAGE_LABEL[stage]}
          </span>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={busy}
            onClick={handleResume}
            className="min-w-[16rem] rounded-full px-6"
          >
            {busy ? humanizeStage(stage, 'Funding') : `Lock $${contractValueUsdc} USDC into escrow`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* BuyerMilestoneRow                                                           */
/* -------------------------------------------------------------------------- */

function BuyerMilestoneRow({
  wallet,
  rfpPda,
  milestone,
  winnerProvider,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  milestone: MilestoneSummary;
  winnerProvider: Address | null;
  // biome-ignore lint/suspicious/noExplicitAny: hook type drift
  signTransactions: any;
}) {
  const [busy, setBusy] = useState(false);
  const [splitInput, setSplitInput] = useState('5000');
  const [pendingCancel, setPendingCancel] = useState<CancelMilestonePayload | null>(null);

  async function run(action: () => Promise<string>, label: string) {
    setBusy(true);
    try {
      const sig = await action();
      toast.success(`${label} done`, {
        description: <TxToastDescription hash={sig} prefix="Tx" />,
      });
    } catch (e) {
      toast.error(`${label} failed`, { description: friendlyBidError(e), duration: 12000 });
    } finally {
      setBusy(false);
    }
  }

  const amountUsdc = (Number(milestone.amount) / 1_000_000).toFixed(2);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-sm font-semibold">
            Milestone {milestone.index + 1}
          </span>
          <StatusBadge status={milestone.status} />
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {amountUsdc} USDC
        </span>
      </div>

      {/* Submitted: review window countdown + accept/changes/reject */}
      {milestone.status === 'submitted' && (
        <>
          {milestone.reviewDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Auto-releases to provider <LocalTime iso={milestone.reviewDeadlineIso} /> if you do
              nothing. Iteration {milestone.iterationCount + 1}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !winnerProvider}
              onClick={() =>
                run(
                  () =>
                    acceptMilestone({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      mint: DEVNET_MOCK_USDC_MINT,
                      providerPayoutWallet: winnerProvider!,
                      signTransactions,
                      rpc,
                    }),
                  'Accept milestone',
                )
              }
            >
              Accept ({amountUsdc} USDC → provider, 2.5% fee)
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    requestChanges({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      signTransactions,
                      rpc,
                    }),
                  'Request changes',
                )
              }
            >
              Request changes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy || !winnerProvider}
              onClick={() =>
                run(
                  () =>
                    rejectMilestone({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      providerPayoutWallet: winnerProvider!,
                      signTransactions,
                      rpc,
                    }),
                  'Reject milestone',
                )
              }
            >
              Reject (escalates to dispute)
            </Button>
          </div>
        </>
      )}

      {/* Pending: cancel-with-notice (full refund, no rep ding) */}
      {milestone.status === 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setPendingCancel({ index: milestone.index, amountUsdc, kind: 'notice' })}
          >
            Cancel (full refund - provider hasn't started)
          </Button>
        </div>
      )}

      {/* Started: late-cancel (no penalty) when past delivery_deadline,
            else penalty cancel. Submitted always uses penalty. */}
      {milestone.status === 'started' && winnerProvider && (
        <div className="flex flex-col gap-2">
          {milestone.deliveryDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Provider committed to deliver by <LocalTime iso={milestone.deliveryDeadlineIso} />.
              {new Date(milestone.deliveryDeadlineIso).getTime() < Date.now() && (
                <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">
                  Deadline passed.
                </span>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {milestone.deliveryDeadlineIso &&
              new Date(milestone.deliveryDeadlineIso).getTime() < Date.now() && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setPendingCancel({ index: milestone.index, amountUsdc, kind: 'late' })
                  }
                >
                  Cancel (provider late · full refund)
                </Button>
              )}
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                setPendingCancel({ index: milestone.index, amountUsdc, kind: 'penalty' })
              }
            >
              Abort (50% penalty)
            </Button>
          </div>
        </div>
      )}
      {milestone.status === 'submitted' && winnerProvider && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              setPendingCancel({ index: milestone.index, amountUsdc, kind: 'penalty' })
            }
          >
            Abort (50% penalty)
          </Button>
        </div>
      )}

      {/* Disputed: propose split / wait */}
      {milestone.status === 'disputed' && winnerProvider && (
        <div className="flex flex-col gap-2">
          {milestone.disputeDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Cool-off ends <LocalTime iso={milestone.disputeDeadlineIso} />. Both parties must
              propose the SAME split for funds to release. Settle off-platform first, then both
              sign.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`split-${milestone.index}`} className="text-xs">
              Your proposed split to provider (bps, 0–10000)
            </Label>
            <Input
              id={`split-${milestone.index}`}
              type="number"
              min={0}
              max={10000}
              className="w-24 font-mono"
              value={splitInput}
              onChange={(e) => setSplitInput(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    proposeDisputeSplit({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      splitToProviderBps: Number(splitInput),
                      mint: DEVNET_MOCK_USDC_MINT,
                      buyerWallet: wallet,
                      providerPayoutWallet: winnerProvider,
                      signTransactions,
                      rpc,
                    }),
                  'Propose split',
                )
              }
            >
              Propose split
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    disputeDefaultSplit({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      mint: DEVNET_MOCK_USDC_MINT,
                      buyerWallet: wallet,
                      providerPayoutWallet: winnerProvider,
                      signTransactions,
                      rpc,
                    }),
                  'Default 50/50',
                )
              }
            >
              Apply default 50/50 (cool-off must have expired)
            </Button>
          </div>
        </div>
      )}

      <CancelMilestoneDialog
        open={pendingCancel !== null}
        onOpenChange={(o) => {
          if (!o) setPendingCancel(null);
        }}
        pending={pendingCancel}
        busy={busy}
        onConfirm={async () => {
          if (!pendingCancel) return;
          const kind = pendingCancel.kind;
          const action =
            kind === 'notice'
              ? () =>
                  cancelWithNotice({
                    signer: wallet,
                    rfpPda,
                    milestoneIndex: pendingCancel.index,
                    mint: DEVNET_MOCK_USDC_MINT,
                    signTransactions,
                    rpc,
                  })
              : kind === 'late'
                ? () =>
                    cancelLateMilestone({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: pendingCancel.index,
                      mint: DEVNET_MOCK_USDC_MINT,
                      providerPayoutWallet: winnerProvider!,
                      signTransactions,
                      rpc,
                    })
                : () =>
                    cancelWithPenalty({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: pendingCancel.index,
                      mint: DEVNET_MOCK_USDC_MINT,
                      providerPayoutWallet: winnerProvider!,
                      signTransactions,
                      rpc,
                    });
          const label =
            kind === 'notice'
              ? 'Cancel milestone'
              : kind === 'late'
                ? 'Cancel late milestone'
                : 'Cancel with penalty';
          // Close dialog before running so user sees the row state update.
          setPendingCancel(null);
          await run(action, label);
        }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'released' || status === 'accepted' || status === 'disputeresolved'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30'
      : status === 'disputed' || status === 'disputedefault'
        ? 'bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30'
        : status === 'submitted'
          ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30'
          : 'bg-muted text-muted-foreground border-border';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}
    >
      {status}
    </span>
  );
}

function usdcToBaseUnits(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(6, '0').slice(0, 6);
  return BigInt(whole ?? '0') * 1_000_000n + BigInt(fracPadded || '0');
}

function microUsdcDisplay(micro: string): string {
  return (Number(micro) / 1_000_000).toFixed(2);
}

void markBuyerGhosted; // exported helper for the (future) provider-side panel
