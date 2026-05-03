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
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { MilestoneNotesThread } from '@/components/escrow/milestone-notes-thread';
import { ProviderWinningBidPanel } from '@/components/escrow/winning-bid-panel';
import { LocalTime } from '@/components/local-time';
import { TxToastDescription } from '@/components/primitives/tx-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { friendlyBidError } from '@/lib/bids/error-utils';
import type { SealedBidPlaintext } from '@/lib/bids/schema';
import {
  autoReleaseMilestone,
  disputeDefaultSplit,
  proposeDisputeSplit,
  startMilestone,
  submitMilestone,
} from '@/lib/escrow/milestone-flow';
import { postMilestoneNote } from '@/lib/milestones/notes';
import { rpc } from '@/lib/solana/client';
import type { MilestoneNoteRow } from '@tender/shared';

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
  /** Off-chain notes attached to milestone state transitions, grouped by
   *  milestone_index. Render at the bottom of each row. */
  notesByMilestoneIndex: Record<number, MilestoneNoteRow[]>;
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
  winnerBidPda,
  winnerProvider,
  milestones,
  activeMilestoneIndex,
  notesByMilestoneIndex,
}: ProviderActionPanelProps & { account: UiWalletAccount }) {
  const signTransactions = useSignTransactions(account, 'solana:devnet');
  const wallet = account.address as Address;

  if (rfpStatus !== 'funded' && rfpStatus !== 'inprogress' && rfpStatus !== 'disputed') {
    return null;
  }

  const slotTaken = activeMilestoneIndex !== 255;

  // Lazily-decrypted winning-bid plaintext. A single decrypt unlocks the
  // success-criteria acceptance bar in every milestone row + the dispute UI.
  // State lives at this level so the decrypt button is shown once at the top
  // of the card, not per-row.
  const [plaintext, setPlaintext] = useState<SealedBidPlaintext | null>(null);
  const successByIndex: Record<number, string | undefined> = {};
  if (plaintext) {
    plaintext.milestones.forEach((m, i) => {
      successByIndex[i] = m.successCriteria;
    });
  }

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
        {winnerBidPda && (
          <ProviderWinningBidPanel
            rfpPda={rfpPda as Address}
            winnerBidPda={winnerBidPda as Address}
            plaintext={plaintext}
            onDecrypted={setPlaintext}
          />
        )}
        {milestones.map((ms) => (
          <ProviderMilestoneRow
            key={ms.index}
            wallet={wallet}
            rfpPda={rfpPda as Address}
            buyerWallet={buyerWallet as Address}
            winnerProvider={winnerProvider as Address}
            milestone={ms}
            successCriteria={successByIndex[ms.index]}
            notes={notesByMilestoneIndex[ms.index] ?? []}
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
  successCriteria,
  notes,
  slotTaken,
  signTransactions,
}: {
  wallet: Address;
  rfpPda: Address;
  buyerWallet: Address;
  winnerProvider: Address;
  milestone: MilestoneSummary;
  /** What the provider committed this milestone would deliver, sourced from
   *  the decrypted bid envelope. Undefined when not yet decrypted OR when
   *  the provider declined to set one. */
  successCriteria?: string;
  /** Off-chain notes already posted against this milestone. Rendered as a
   *  thread at the bottom of the row. */
  notes: MilestoneNoteRow[];
  slotTaken: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: wallet-standard
  signTransactions: any;
}) {
  const [busy, setBusy] = useState(false);
  const [splitInput, setSplitInput] = useState('5000');
  /** Inline note that ships with the next Submit click. Cleared after a
   *  successful post. Strongly encouraged: gives the buyer the deliverable
   *  link / what-shipped context inline with the on-chain Submit. */
  const [submitNote, setSubmitNote] = useState('');
  const router = useRouter();

  async function run(
    action: () => Promise<string>,
    label: string,
    opts?: {
      note?: { kind: MilestoneNoteRow['kind']; body: string; onPosted?: () => void };
    },
  ) {
    setBusy(true);
    try {
      const sig = await action();
      toast.success(`${label} done`, {
        description: <TxToastDescription hash={sig} prefix="Tx" />,
      });
      const body = opts?.note?.body.trim();
      if (body && opts?.note) {
        const res = await postMilestoneNote({
          rfp_pda: rfpPda,
          milestone_index: milestone.index,
          kind: opts.note.kind,
          body,
          tx_signature: sig,
        });
        if (res.ok) {
          opts.note.onPosted?.();
        } else {
          toast.warning('Note not saved', { description: res.error });
        }
      }
      // Re-fetch on-chain state so the next render reflects reality.
      router.refresh();
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

      {/* Acceptance bar - what YOU committed at submit time. Shown inline so
          you can re-read it before clicking Submit, and so it's right there
          when reviewing dispute UI. Hidden until plaintext is decrypted at
          the panel level + when no criterion was set. */}
      {successCriteria && milestone.status !== 'disputed' && (
        <p className="rounded-md border border-primary/15 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed text-foreground/80">
          <span className="font-medium text-primary/80">Your committed acceptance bar:</span>{' '}
          {successCriteria}
        </p>
      )}

      {milestone.status === 'pending' && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Click START when you're actually beginning work. Once started, the buyer can only cancel
            with a 50% penalty (paid to you) - unless you miss your delivery deadline, in which case
            they can cancel with a full refund and a late mark goes on your reputation.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
          {/* Inline delivery note - what's shipping in this submit. Optional
              but strongly encouraged: the buyer is reviewing on-chain status
              + this note together, so a deliverable link or summary here
              cuts back-and-forth. Posted as an off-chain note attached to
              the Submit tx signature on success. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`submit-note-${milestone.index}`} className="text-[11px]">
              What's shipping?{' '}
              <span className="text-muted-foreground">
                (optional, posts with Submit - link the deliverable, summarize the work)
              </span>
            </Label>
            <textarea
              id={`submit-note-${milestone.index}`}
              className="min-h-[60px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-xs leading-relaxed shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              placeholder="e.g. https://github.com/me/repo/pull/42 — implements the access-control checks per the acceptance bar; ready for buyer review."
              maxLength={2000}
              value={submitNote}
              onChange={(e) => setSubmitNote(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex justify-end">
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
                  {
                    note: {
                      kind: 'submit',
                      body: submitNote,
                      onPosted: () => setSubmitNote(''),
                    },
                  },
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
                          buyerWallet,
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
          {/* In a dispute, the acceptance bar IS the resolution reference -
              both parties can re-read what the provider committed to vs what
              actually shipped. Surface it more prominently than in other
              states so you can ground your proposed split in the original
              commitment, not vibes. */}
          {successCriteria && (
            <div className="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Your committed acceptance bar
              </span>
              <p className="text-xs leading-relaxed text-foreground/85">{successCriteria}</p>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Use this as the reference when proposing a split - it's the bar you signed up to at
                submit time.
              </p>
            </div>
          )}
          {milestone.disputeDeadlineIso && (
            <p className="text-xs text-muted-foreground">
              Cool-off ends <LocalTime iso={milestone.disputeDeadlineIso} />. Settle off-platform
              with the buyer first, then both of you propose the SAME split here.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
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

      <MilestoneNotesThread notes={notes} />
    </div>
  );
}
