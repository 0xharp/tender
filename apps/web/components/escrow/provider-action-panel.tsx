'use client';

import type { Address } from '@solana/kit';
/**
 * Provider-side action panel rendered on the RFP detail page.
 *
 * Shows up only when the connected wallet is the winning provider (matches
 * `rfp.winner_provider`). Surfaces start/submit/auto-release/dispute-propose
 * for each milestone in flight.
 */
import { useSelectedWalletAccount, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useState } from 'react';
import { toast } from 'sonner';

import { LocalTime } from '@/components/local-time';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { friendlyBidError } from '@/lib/bids/error-utils';
import {
  autoReleaseMilestone,
  disputeDefaultSplit,
  proposeDisputeSplit,
  startMilestone,
  submitMilestone,
} from '@/lib/escrow/milestone-flow';
import { rpc } from '@/lib/solana/client';

import type { MilestoneSummary } from './buyer-action-panel';

/** Circle's devnet USDC mint. */
const DEVNET_MOCK_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;

export interface ProviderActionPanelProps {
  rfpPda: string;
  rfpStatus: string;
  buyerWallet: string;
  winnerBidPda: string | null;
  winnerProvider: string | null;
  milestoneCount: number;
  milestones: MilestoneSummary[];
  /** rfp.active_milestone_index - sentinel 255 = none in flight. Drives the
   *  Start-button gating (only one milestone can be Started at a time). */
  activeMilestoneIndex: number;
}

export function ProviderActionPanel(props: ProviderActionPanelProps) {
  const [account] = useSelectedWalletAccount();
  if (!account) return null;
  if (!props.winnerProvider) return null;
  // Render only when the connected wallet IS the winner_provider.
  // Post-simplification: winner_provider is always the verified main wallet
  // (cryptographically bound at select_bid via Ed25519SigVerify), so the
  // provider just needs to connect their main wallet to manage milestones -
  // no separate "attest later" step needed.
  if (account.address !== props.winnerProvider) {
    return null;
  }
  return <ConnectedProviderPanel account={account} {...props} />;
}

function ConnectedProviderPanel({
  account,
  rfpPda,
  rfpStatus,
  buyerWallet,
  winnerProvider,
  milestones,
  activeMilestoneIndex,
}: ProviderActionPanelProps & { account: UiWalletAccount }) {
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const wallet = account.address as Address;

  if (rfpStatus !== 'funded' && rfpStatus !== 'inprogress' && rfpStatus !== 'disputed') {
    return null;
  }

  const slotTaken = activeMilestoneIndex !== 255;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your work - milestone progress</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="rounded-lg border border-dashed border-border/60 bg-card/40 p-3 text-xs leading-relaxed text-muted-foreground">
          Only one milestone can be in flight at a time. Submit the active one before starting the
          next.
          {slotTaken && (
            <span className="ml-1 font-medium text-amber-700 dark:text-amber-400">
              Milestone {activeMilestoneIndex + 1} is currently active.
            </span>
          )}
        </p>
        {milestones.map((ms) => (
          <ProviderMilestoneRow
            key={ms.index}
            wallet={wallet}
            rfpPda={rfpPda as Address}
            buyerWallet={buyerWallet as Address}
            winnerProvider={winnerProvider as Address}
            milestone={ms}
            slotTaken={slotTaken}
            // biome-ignore lint/suspicious/noExplicitAny: wallet-standard hook
            signTransactions={signTransactions as any}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ProviderMilestoneRow({
  wallet,
  rfpPda,
  buyerWallet,
  winnerProvider,
  milestone,
  slotTaken,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  buyerWallet: Address;
  winnerProvider: Address;
  milestone: MilestoneSummary;
  slotTaken: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard
  signTransactions: any;
}) {
  const [busy, setBusy] = useState(false);
  const [splitInput, setSplitInput] = useState('5000');

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
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {milestone.status}
          </span>
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {amountUsdc} USDC (you receive {(Number(amountUsdc) * 0.975).toFixed(2)} after 2.5% fee)
        </span>
      </div>

      {milestone.status === 'pending' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Click START when you're actually beginning work. Once started, the buyer can only cancel
            with a 50% penalty (paid to you) - unless you miss your delivery deadline, in which case
            they can cancel with a full refund and a late mark goes on your reputation.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || slotTaken}
              title={slotTaken ? 'Another milestone is in flight. Submit it first.' : undefined}
              onClick={() =>
                run(
                  () =>
                    startMilestone({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      signTransactions,
                      rpc,
                    }),
                  'Start milestone',
                )
              }
            >
              {slotTaken ? 'Start (waiting on active milestone)' : 'Start this milestone'}
            </Button>
          </div>
        </div>
      )}

      {milestone.status === 'started' && milestone.deliveryDeadlineIso && (
        <p className="text-xs text-muted-foreground">
          Deliver by <LocalTime iso={milestone.deliveryDeadlineIso} />. After this, the buyer can
          cancel with a full refund and a late mark goes on your reputation.
        </p>
      )}

      {milestone.status === 'started' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Submit when the work is delivery-ready. Buyer then has the review window to accept,
            request changes, or reject.
          </p>
          <div className="flex">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    submitMilestone({
                      signer: wallet,
                      rfpPda,
                      milestoneIndex: milestone.index,
                      signTransactions,
                      rpc,
                    }),
                  'Submit milestone',
                )
              }
            >
              Submit for review
            </Button>
          </div>
        </div>
      )}

      {milestone.status === 'submitted' && (
        <div className="flex flex-col gap-2">
          {milestone.reviewDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Buyer has until <LocalTime iso={milestone.reviewDeadlineIso} /> to act. If they don't,
              anyone (including you) can call auto-release.
            </p>
          )}
          {milestone.reviewDeadlineIso &&
            new Date(milestone.reviewDeadlineIso).getTime() < Date.now() && (
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        autoReleaseMilestone({
                          signer: wallet,
                          rfpPda,
                          milestoneIndex: milestone.index,
                          mint: DEVNET_MOCK_USDC_MINT,
                          providerPayoutWallet: winnerProvider,
                          signTransactions,
                          rpc,
                        }),
                      'Auto-release',
                    )
                  }
                >
                  Trigger auto-release (silence = consent)
                </Button>
              </div>
            )}
        </div>
      )}

      {milestone.status === 'disputed' && (
        <div className="flex flex-col gap-2">
          {milestone.disputeDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Cool-off ends <LocalTime iso={milestone.disputeDeadlineIso} />. Settle off-platform
              with the buyer first, then both of you propose the SAME split here.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs">Your split bps (0=nothing, 10000=full)</Label>
            <Input
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
                      buyerWallet,
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
                      buyerWallet,
                      providerPayoutWallet: winnerProvider,
                      signTransactions,
                      rpc,
                    }),
                  'Apply default split',
                )
              }
            >
              Apply 50/50 default (cool-off must have expired)
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
