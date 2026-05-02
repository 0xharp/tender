import { ArrowRightIcon } from 'lucide-react';
import Link from 'next/link';

import { SectionHeader } from '@/components/primitives/section-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = {
  title: 'RFP lifecycle - tendr.bid',
  description:
    'Reference: every stage an RFP passes through, the on-chain status it maps to, and the action that moves it forward.',
};

export default function LifecycleDocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeader
        eyebrow="Docs · Reference"
        title="RFP lifecycle"
        size="md"
        description={
          <>
            Every RFP moves through a small set of on-chain states. The lifecycle bar on the RFP
            detail page reflects the on-chain truth. This page maps each visible stage to the
            program state behind it, the action that triggers each transition, and what fails
            close-by.
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stages - the happy path</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Stage</th>
                <th className="py-2 pr-3 font-medium">On-chain RfpStatus</th>
                <th className="py-2 pr-3 font-medium">Enters via</th>
                <th className="py-2 pr-3 font-medium">Leaves via</th>
                <th className="py-2 font-medium">Details we surface</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 [&>tr>td]:py-3 [&>tr>td]:pr-3 [&>tr>td]:align-top">
              <tr>
                <td className="font-medium">Bidding</td>
                <td>
                  <Code>Open</Code>
                </td>
                <td>
                  <Code>rfp_create</Code> (buyer)
                </td>
                <td>
                  <Code>rfp_close_bidding</Code> (anyone, after <Code>bid_close_at</Code>)
                </td>
                <td>
                  Bidding-window close + reveal-window close. If the bid window has expired but
                  on-chain status is still <Code>Open</Code>, an amber note tells the buyer they
                  can flip to Reveal.
                </td>
              </tr>
              <tr>
                <td className="font-medium">Reveal &amp; select</td>
                <td>
                  <Code>Reveal</Code> (or <Code>BidsClosed</Code>)
                </td>
                <td>
                  <Code>rfp_close_bidding</Code>
                </td>
                <td>
                  <Code>select_bid</Code> (buyer)
                </td>
                <td>Reveal-window close time.</td>
              </tr>
              <tr>
                <td className="font-medium">Awarded</td>
                <td>
                  <Code>Awarded</Code>
                </td>
                <td>
                  <Code>select_bid</Code>
                </td>
                <td>
                  <Code>fund_project</Code> (buyer)
                </td>
                <td>
                  Funding deadline = <Code>select_bid</Code> time + <Code>funding_window_secs</Code>{' '}
                  (default 3 days). After this expires, anyone can call{' '}
                  <Code>mark_buyer_ghosted</Code>.
                </td>
              </tr>
              <tr>
                <td className="font-medium">Funded</td>
                <td>
                  <Code>Funded</Code>
                </td>
                <td>
                  <Code>fund_project</Code>
                </td>
                <td>
                  <Code>start_milestone</Code> (provider, on the first milestone)
                </td>
                <td>
                  Milestones <Code>X / Y</Code> settled.
                </td>
              </tr>
              <tr>
                <td className="font-medium">In progress</td>
                <td>
                  <Code>InProgress</Code>
                </td>
                <td>
                  <Code>start_milestone</Code> auto-flips Funded → InProgress
                </td>
                <td>
                  Each settled milestone increments the counter; auto-flips to{' '}
                  <Code>Completed</Code> when every milestone is in a terminal state.
                </td>
                <td>
                  Milestones <Code>X / Y</Code> settled.
                </td>
              </tr>
              <tr>
                <td className="font-medium">Completed</td>
                <td>
                  <Code>Completed</Code>
                </td>
                <td>
                  Auto-set inside <Code>accept_milestone</Code> /{' '}
                  <Code>auto_release_milestone</Code> / cancel paths / <Code>resolve_dispute</Code>
                  &nbsp;once <Code>total_released + total_refunded ≥ total_locked</Code>.
                </td>
                <td>Terminal.</td>
                <td>"All milestones released or refunded. Project is done."</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Failure paths</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-xs text-muted-foreground">
            When an RFP enters one of these states, the lifecycle bar is replaced with a
            destructive-tone summary card.
          </p>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">RfpStatus</th>
                <th className="py-2 pr-3 font-medium">Set by</th>
                <th className="py-2 font-medium">What we show</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40 [&>tr>td]:py-3 [&>tr>td]:pr-3 [&>tr>td]:align-top">
              <tr>
                <td>
                  <Code>Cancelled</Code>
                </td>
                <td>(reserved for future cancel-RFP ix; currently unused)</td>
                <td>"RFP was cancelled. No award, no funds locked."</td>
              </tr>
              <tr>
                <td>
                  <Code>GhostedByBuyer</Code>
                </td>
                <td>
                  <Code>mark_buyer_ghosted</Code> (anyone, after the funding deadline expires while
                  status is still <Code>Awarded</Code>)
                </td>
                <td>
                  "Buyer awarded a winner but never funded within the funding window."
                </td>
              </tr>
              <tr>
                <td>
                  <Code>Disputed</Code>
                </td>
                <td>
                  <Code>reject_milestone</Code> (buyer) - milestone enters dispute path; flips RFP
                  status to Disputed
                </td>
                <td>"A milestone is in dispute. Resolution pending."</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Full instruction → state-transition map</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <Section title="RFP-level transitions">
            <Trans
              ix="rfp_create"
              who="buyer"
              effect={
                <>
                  Creates the Rfp account with status <Code>Open</Code>. Sets bid windows, reserve
                  commitment, fee_bps, and per-RFP windows (funding / review / dispute / cancel).
                  Milestone count = 0; populated later by <Code>select_bid</Code>.
                </>
              }
            />
            <Trans
              ix="rfp_close_bidding"
              who="anyone, after bid_close_at"
              effect={
                <>
                  <Code>Open → Reveal</Code>. Permissionless: usually the buyer triggers it but a
                  bot or any wallet can advance the RFP once the bid window has expired.
                </>
              }
            />
            <Trans
              ix="select_bid"
              who="buyer, before reveal_close_at"
              effect={
                <>
                  <Code>Reveal → Awarded</Code>. Writes <Code>winner</Code>,{' '}
                  <Code>contract_value</Code>, <Code>milestone_amounts</Code>,{' '}
                  <Code>milestone_durations_secs</Code>, and the funding deadline. Provider rep
                  <Code> total_won_usdc</Code> bumps. For private bids, an Ed25519SigVerify ix at
                  index 0 cryptographically binds the main wallet to the bid.
                </>
              }
            />
            <Trans
              ix="mark_buyer_ghosted"
              who="anyone, after funding_deadline"
              effect={
                <>
                  <Code>Awarded → GhostedByBuyer</Code>. Buyer rep <Code>ghosted_rfps</Code> bumps.
                  Provider receives no payout but frees up the RFP slot.
                </>
              }
            />
            <Trans
              ix="fund_project"
              who="buyer, before funding_deadline"
              effect={
                <>
                  <Code>Awarded → Funded</Code>. Locks the full <Code>contract_value</Code> into
                  the escrow ATA + creates N <Code>MilestoneState</Code> PDAs at the amounts the
                  winning bid quoted.
                </>
              }
            />
          </Section>

          <Section title="Milestone-level transitions">
            <p className="text-xs text-muted-foreground">
              Most of these don't change <Code>RfpStatus</Code> directly except where called out.
            </p>
            <Trans
              ix="start_milestone"
              who="provider"
              effect={
                <>
                  Milestone <Code>Pending → Started</Code>. Sets <Code>delivery_deadline</Code> ={' '}
                  <Code>now + duration</Code>. Sets <Code>rfp.active_milestone_index</Code>.{' '}
                  <strong>Flips RFP <Code>Funded → InProgress</Code></strong> on first start.
                  Enforces "only one milestone in flight at a time".
                </>
              }
            />
            <Trans
              ix="submit_milestone"
              who="provider, milestone Started"
              effect={
                <>
                  <Code>Started → Submitted</Code>. Sets <Code>review_deadline = now +
                  review_window_secs</Code>. Slot stays active.
                </>
              }
            />
            <Trans
              ix="accept_milestone"
              who="buyer, milestone Submitted"
              effect={
                <>
                  <Code>Submitted → Released</Code>. Releases the milestone amount from escrow:
                  provider gets <Code>amount × (1 − fee_bps/10_000)</Code>, treasury gets the fee.
                  Clears <Code>active_milestone_index</Code>. Auto-flips RFP to{' '}
                  <Code>Completed</Code> when every milestone is terminal.
                </>
              }
            />
            <Trans
              ix="auto_release_milestone"
              who="anyone, after review_deadline"
              effect={<>Identical effect to <Code>accept_milestone</Code>. Silence = consent.</>}
            />
            <Trans
              ix="request_changes"
              who="buyer, milestone Submitted, iteration_count < max_iterations"
              effect={
                <>
                  Reverts <Code>Submitted → Started</Code>. Increments iteration_count. Slot stays
                  active so provider can iterate.
                </>
              }
            />
            <Trans
              ix="reject_milestone"
              who="buyer, milestone Submitted"
              effect={
                <>
                  <Code>Submitted → Disputed</Code>. Sets <Code>dispute_deadline</Code>.{' '}
                  <strong>Flips RFP <Code>InProgress → Disputed</Code>.</strong>
                </>
              }
            />
            <Trans
              ix="resolve_dispute"
              who="both parties sign matching split"
              effect={
                <>
                  <Code>Disputed → DisputeResolved</Code>. Releases per the agreed split (with
                  platform fee on provider's portion). Clears active. RFP returns to{' '}
                  <Code>InProgress</Code> or auto-flips to <Code>Completed</Code>.
                </>
              }
            />
            <Trans
              ix="dispute_default_split"
              who="anyone, after dispute_deadline"
              effect={
                <>
                  <Code>Disputed → DisputeDefault</Code>. Hardcoded 50/50 split. Deliberately
                  unsatisfying - its purpose is to push parties to settle off-platform via{' '}
                  <Code>resolve_dispute</Code>.
                </>
              }
            />
            <Trans
              ix="cancel_with_notice"
              who="buyer, milestone Pending"
              effect={
                <>
                  <Code>Pending → CancelledByBuyer</Code>. Full refund to buyer.{' '}
                  <strong>No reputation ding</strong> - provider hadn't started, no work wasted.
                </>
              }
            />
            <Trans
              ix="cancel_with_penalty"
              who="buyer, milestone Started or Submitted"
              effect={
                <>
                  <Code>Started/Submitted → CancelledByBuyer</Code>. 50% to provider as
                  ramp-down compensation, 50% refund to buyer. Clears active. Buyer rep{' '}
                  <Code>cancelled_milestones += 1</Code>.
                </>
              }
            />
            <Trans
              ix="cancel_late_milestone"
              who="buyer, milestone Started + past delivery_deadline"
              effect={
                <>
                  <Code>Started → CancelledByBuyer</Code>. <strong>Full refund</strong>, no
                  penalty. Clears active. Provider rep <Code>late_milestones += 1</Code> - buyer
                  takes no ding because the deadline was the provider's commitment.
                </>
              }
            />
          </Section>
        </CardContent>
      </Card>

      <Card className="border-dashed border-border/60 bg-card/40">
        <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Want the canonical source?</p>
            <p className="text-xs text-muted-foreground">
              The Anchor program is the truth. Each instruction file in{' '}
              <Code>programs/tender/src/instructions/</Code> is exactly one transition.
            </p>
          </div>
          <Link
            href="https://github.com/0xharp/tender/tree/main/programs/tender/src/instructions"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium hover:bg-card"
          >
            Browse the source <ArrowRightIcon className="size-3" />
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-display text-sm font-semibold tracking-tight">{title}</h3>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Trans({
  ix,
  who,
  effect,
}: {
  ix: string;
  who: string;
  effect: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 rounded-xl border border-border/60 bg-card/40 p-3 sm:grid-cols-[12rem_1fr]">
      <div className="flex flex-col gap-0.5">
        <code className="font-mono text-xs font-semibold text-foreground">{ix}</code>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{who}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{effect}</p>
    </div>
  );
}
