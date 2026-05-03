/**
 * "Your projects" data layer - enumerates every RFP the connected wallet has
 * skin in (as buyer or as winning provider) and computes the next concrete
 * action they should take. Backs `/me/projects`, the operational workbench.
 *
 * Data sources are all on-chain (Rfp + MilestoneState + Escrow accounts);
 * supabase only joins the human-readable title/scope when present.
 *
 * The "next action" computation lives here (not in the page) so it can be
 * unit-tested + reused by future surfaces (notification badges, dashboard
 * preview, email digests).
 */
import type { Address } from '@solana/kit';

import {
  type MilestoneStateChain,
  type RfpChain,
  fetchMilestones,
  listRfps,
  milestoneStatusToString,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';

export type ProjectRole = 'buyer' | 'provider';

/** Urgency tiers for the next-action hint. Drives card styling on the page.
 *   - now: viewer is the one currently blocking forward progress
 *   - soon: deadline is coming up but no action required *yet*
 *   - wait: counterparty's turn; viewer has nothing to do
 *   - done: terminal state (completed/cancelled/ghosted) */
export type NextActionUrgency = 'now' | 'soon' | 'wait' | 'done';

export interface NextAction {
  urgency: NextActionUrgency;
  /** Short imperative shown on the project card (e.g. "Submit milestone 2"). */
  label: string;
  /** Why this action / why no action - one-liner subtitle. */
  hint: string;
}

export interface ProjectRow {
  rfpPda: string;
  title: string | null;
  status: string;
  role: ProjectRole;
  contractValueMicroUsdc: bigint;
  /** 1-indexed milestone the user should focus on. Null when no milestone is
   *  active (pre-fund, completed, cancelled). */
  focusMilestone1Indexed: number | null;
  /** Total milestone count post-award; null pre-award. */
  milestoneCount: number;
  /** rfp.created_at as ISO; used for default sort within urgency tiers. */
  createdAtIso: string;
  /** Funding-deadline if status is awarded, else review/dispute/delivery
   *  deadline of the active milestone. ISO or null. */
  pendingDeadlineIso: string | null;
  nextAction: NextAction;
}

const NO_ACTIVE_MILESTONE = 255;

/**
 * Fetch all projects the wallet is involved in (buyer or winning provider).
 * Returns a flat list - the page groups by urgency.
 */
export async function listProjectsForWallet(wallet: Address): Promise<ProjectRow[]> {
  // Both queries hit getProgramAccounts with their own memcmp filter.
  const [asBuyer, asWinner] = await Promise.all([
    listRfps({ buyer: wallet }),
    listRfps({ winnerProvider: wallet }),
  ]);

  // Dedupe by PDA - if a wallet ever bought + won the same RFP (impossible
  // today since program rejects same-wallet bids, but defensive). Buyer role
  // wins the dedupe since that's the more action-heavy seat.
  const seen = new Set<string>();
  const tagged: { rfp: (typeof asBuyer)[number]; role: ProjectRole }[] = [];
  for (const r of asBuyer) {
    seen.add(r.address);
    tagged.push({ rfp: r, role: 'buyer' });
  }
  for (const r of asWinner) {
    if (seen.has(r.address)) continue;
    tagged.push({ rfp: r, role: 'provider' });
  }

  if (tagged.length === 0) return [];

  // Pull metadata + milestones in one parallel pass.
  const supabase = await serverSupabase();
  const [{ data: metaRows }, milestonesByPda] = await Promise.all([
    supabase
      .from('rfps')
      .select('on_chain_pda, title')
      .in(
        'on_chain_pda',
        tagged.map((t) => t.rfp.address),
      ),
    Promise.all(
      tagged.map(async (t) => {
        const count = t.rfp.data.milestoneCount;
        if (count === 0) return { pda: t.rfp.address, milestones: [] };
        const ms = await fetchMilestones(t.rfp.address as Address, count);
        return { pda: t.rfp.address, milestones: ms };
      }),
    ).then((arr) => {
      const out: Record<string, (MilestoneStateChain | null)[]> = {};
      for (const { pda, milestones } of arr) out[pda] = milestones;
      return out;
    }),
  ]);

  const titleByPda = new Map<string, string>();
  for (const m of metaRows ?? []) titleByPda.set(m.on_chain_pda, m.title);

  const now = Date.now();
  const rows: ProjectRow[] = tagged.map(({ rfp, role }) => {
    const status = rfpStatusToString(rfp.data.status);
    const milestones = milestonesByPda[rfp.address] ?? [];
    const next = computeNextAction({
      role,
      status,
      activeMilestoneIndex: rfp.data.activeMilestoneIndex,
      milestones,
      bidCloseAtMs: Number(rfp.data.bidCloseAt) * 1000,
      revealCloseAtMs: Number(rfp.data.revealCloseAt) * 1000,
      fundingDeadlineMs:
        rfp.data.fundingDeadline > 0n ? Number(rfp.data.fundingDeadline) * 1000 : null,
      nowMs: now,
    });
    const focus = pickFocusMilestone({
      activeMilestoneIndex: rfp.data.activeMilestoneIndex,
      milestones,
    });
    return {
      rfpPda: rfp.address,
      title: titleByPda.get(rfp.address) ?? null,
      status,
      role,
      contractValueMicroUsdc: rfp.data.contractValue,
      focusMilestone1Indexed: focus !== null ? focus + 1 : null,
      milestoneCount: rfp.data.milestoneCount,
      createdAtIso: unixSecondsToIso(rfp.data.createdAt),
      pendingDeadlineIso: pickPendingDeadline({
        status,
        rfp: rfp.data,
        milestones,
        focusIndex: focus,
      }),
      nextAction: next,
    };
  });

  return rows;
}

/* -------------------------------------------------------------------------- */
/* Next-action computation                                                     */
/* -------------------------------------------------------------------------- */

/** "Not proposed" sentinel for milestone split bps fields (see escrow.rs). */
const SPLIT_NOT_PROPOSED = 0xffff;

/** Safe bigint→ms conversion. 0n means "not set" → returns null. */
function deadlineMs(secs: bigint): number | null {
  if (secs === 0n) return null;
  return Number(secs) * 1000;
}

function computeNextAction(args: {
  role: ProjectRole;
  status: string;
  activeMilestoneIndex: number;
  milestones: (MilestoneStateChain | null)[];
  bidCloseAtMs: number;
  revealCloseAtMs: number;
  fundingDeadlineMs: number | null;
  nowMs: number;
}): NextAction {
  const {
    role,
    status,
    activeMilestoneIndex,
    milestones,
    bidCloseAtMs,
    revealCloseAtMs,
    fundingDeadlineMs,
    nowMs,
  } = args;

  // Terminal states - same for both roles.
  if (status === 'completed') {
    return { urgency: 'done', label: 'Completed', hint: 'All milestones released.' };
  }
  if (status === 'cancelled') {
    return {
      urgency: 'done',
      label: 'Cancelled',
      hint: 'All milestones refunded - no work delivered.',
    };
  }
  if (status === 'ghostedbybuyer') {
    return {
      urgency: 'done',
      label: 'Ghosted',
      hint: 'Buyer missed the funding deadline. Reputation hit recorded on chain.',
    };
  }
  if (status === 'expired') {
    return {
      urgency: 'done',
      label: 'Expired',
      hint: 'Reveal window closed without an award. RFP is dead.',
    };
  }

  if (role === 'buyer') {
    if (status === 'open') {
      if (nowMs > bidCloseAtMs) {
        return {
          urgency: 'now',
          label: 'Close bidding',
          hint: 'Bid window has ended. Run close-bidding to lock in submissions.',
        };
      }
      return { urgency: 'wait', label: 'Bidding open', hint: 'Providers can still submit bids.' };
    }
    if (status === 'bidsclosed' || status === 'reveal') {
      // Deadlock fix: if reveal_close_at has passed, select_bid will revert
      // with RevealWindowExpired. The only recovery is calling expire_rfp
      // (permissionless, flips to RfpStatus::Expired). Surface it as the
      // active task instead of the dead "Award the winner" button.
      if (nowMs > revealCloseAtMs) {
        return {
          urgency: 'now',
          label: 'Mark RFP expired',
          hint: 'Reveal window closed without an award. Run expire_rfp to terminate the RFP cleanly.',
        };
      }
      return {
        urgency: 'now',
        label: 'Award the winner',
        hint: 'Decrypt bids, optionally reveal your reserve, and pick a winner before the reveal window closes.',
      };
    }
    if (status === 'awarded') {
      if (fundingDeadlineMs && nowMs > fundingDeadlineMs) {
        return {
          urgency: 'done',
          label: 'Funding window expired',
          hint: 'Anyone can mark you ghosted. Reputation hit incoming.',
        };
      }
      return {
        urgency: 'now',
        label: 'Fund the project',
        hint: fundingDeadlineMs
          ? 'Lock USDC into escrow before the funding deadline.'
          : 'Lock USDC into escrow.',
      };
    }
    if (status === 'funded' || status === 'inprogress' || status === 'disputed') {
      const focus = activeMilestoneIndex === NO_ACTIVE_MILESTONE ? null : activeMilestoneIndex;
      const m = focus !== null ? milestones[focus] : null;
      if (!m) {
        return {
          urgency: 'wait',
          label: 'Waiting on provider to start',
          hint: 'Provider will start the next milestone when ready. You can cancel any pending milestone with full refund.',
        };
      }
      const ms = milestoneStatusToString(m.status);
      if (ms === 'submitted') {
        return {
          urgency: 'now',
          label: `Review milestone ${focus! + 1}`,
          hint: 'Provider submitted - accept, request changes, or reject.',
        };
      }
      if (ms === 'disputed') {
        const buyerSet = m.buyerProposedSplitBps !== SPLIT_NOT_PROPOSED;
        const providerSet = m.providerProposedSplitBps !== SPLIT_NOT_PROPOSED;
        const disputeMs = deadlineMs(m.disputeDeadline);
        if (!buyerSet) {
          return {
            urgency: 'now',
            label: `Propose split for milestone ${focus! + 1}`,
            hint: 'Settle off-platform first, then both parties propose the same split.',
          };
        }
        // Buyer already proposed. If cool-off has passed and provider hasn't
        // matched, the only on-chain way out is the default 50/50 split -
        // anyone can fire it.
        if (disputeMs && nowMs > disputeMs && !providerSet) {
          return {
            urgency: 'now',
            label: `Apply default 50/50 (milestone ${focus! + 1})`,
            hint: 'Cool-off expired without a matching split from the provider. Default 50/50 is the only on-chain way out.',
          };
        }
        // Both proposed but mismatched + cool-off expired = stalemate; fire default.
        if (
          disputeMs &&
          nowMs > disputeMs &&
          providerSet &&
          m.buyerProposedSplitBps !== m.providerProposedSplitBps
        ) {
          return {
            urgency: 'now',
            label: `Apply default 50/50 (milestone ${focus! + 1})`,
            hint: "Splits don't match and cool-off expired. Default 50/50 unblocks settlement.",
          };
        }
        return {
          urgency: 'wait',
          label: `Waiting on provider's split proposal (m${focus! + 1})`,
          hint: 'Your split is on chain. Provider needs to match it for funds to release.',
        };
      }
      if (ms === 'started') {
        const deliveryMs = deadlineMs(m.deliveryDeadline);
        if (deliveryMs && nowMs > deliveryMs) {
          return {
            urgency: 'now',
            label: `Cancel milestone ${focus! + 1} (provider late)`,
            hint: 'Provider missed delivery deadline. Cancel-late gives you a full refund and dings their late-milestones rep.',
          };
        }
        return {
          urgency: 'wait',
          label: `Provider working on milestone ${focus! + 1}`,
          hint: 'Wait for submission or trigger a late-cancel if delivery deadline passes.',
        };
      }
      return {
        urgency: 'wait',
        label: 'Waiting on provider',
        hint: 'No buyer action right now.',
      };
    }
    return { urgency: 'wait', label: status, hint: 'No buyer action right now.' };
  }

  // Provider (winning) role.
  if (status === 'awarded') {
    if (fundingDeadlineMs && nowMs > fundingDeadlineMs) {
      return {
        urgency: 'now',
        label: 'Mark buyer ghosted',
        hint: 'Funding deadline passed. Mark them ghosted to free this RFP slot and ding their reputation.',
      };
    }
    return {
      urgency: 'wait',
      label: 'Waiting on buyer to fund',
      hint: 'Buyer needs to lock USDC into escrow before milestones can start.',
    };
  }
  if (status === 'funded' || status === 'inprogress' || status === 'disputed') {
    if (activeMilestoneIndex === NO_ACTIVE_MILESTONE) {
      // Find the first non-released, non-accepted milestone.
      const next = milestones.findIndex((m) => {
        if (!m) return false;
        const s = milestoneStatusToString(m.status);
        return s === 'pending';
      });
      if (next >= 0) {
        return {
          urgency: 'now',
          label: `Start milestone ${next + 1}`,
          hint: 'No milestone is currently in flight - kick off the next one when ready.',
        };
      }
      return {
        urgency: 'wait',
        label: 'No active milestone',
        hint: 'All milestones are settled or in a terminal state.',
      };
    }
    const m = milestones[activeMilestoneIndex];
    if (!m) {
      return { urgency: 'wait', label: 'Loading...', hint: 'Active milestone state not yet read.' };
    }
    const ms = milestoneStatusToString(m.status);
    if (ms === 'started') {
      const deliveryMs = deadlineMs(m.deliveryDeadline);
      const lateHint =
        deliveryMs && nowMs > deliveryMs
          ? 'Past your delivery deadline - buyer can now cancel for a full refund and ding your late-milestones rep. Submit ASAP.'
          : 'Mark the work delivery-ready so the buyer can review.';
      return {
        urgency: 'now',
        label: `Submit milestone ${activeMilestoneIndex + 1}`,
        hint: lateHint,
      };
    }
    if (ms === 'submitted') {
      const reviewMs = deadlineMs(m.reviewDeadline);
      if (reviewMs && nowMs > reviewMs) {
        return {
          urgency: 'now',
          label: `Auto-release milestone ${activeMilestoneIndex + 1}`,
          hint: 'Buyer review window expired. Trigger auto-release to claim your payout.',
        };
      }
      return {
        urgency: 'wait',
        label: `Buyer reviewing milestone ${activeMilestoneIndex + 1}`,
        hint: 'Auto-releases to you if the buyer goes silent past the review window.',
      };
    }
    if (ms === 'disputed') {
      const providerSet = m.providerProposedSplitBps !== SPLIT_NOT_PROPOSED;
      const buyerSet = m.buyerProposedSplitBps !== SPLIT_NOT_PROPOSED;
      const disputeMs = deadlineMs(m.disputeDeadline);
      if (!providerSet) {
        return {
          urgency: 'now',
          label: `Propose split for milestone ${activeMilestoneIndex + 1}`,
          hint: 'Settle off-platform first, then both parties propose the same split.',
        };
      }
      // Provider proposed; buyer didn't match by deadline → fire default.
      if (disputeMs && nowMs > disputeMs && !buyerSet) {
        return {
          urgency: 'now',
          label: `Apply default 50/50 (milestone ${activeMilestoneIndex + 1})`,
          hint: 'Cool-off expired without a matching split from the buyer. Default 50/50 is the only on-chain way out.',
        };
      }
      // Both proposed but mismatched + cool-off expired = stalemate.
      if (
        disputeMs &&
        nowMs > disputeMs &&
        buyerSet &&
        m.buyerProposedSplitBps !== m.providerProposedSplitBps
      ) {
        return {
          urgency: 'now',
          label: `Apply default 50/50 (milestone ${activeMilestoneIndex + 1})`,
          hint: "Splits don't match and cool-off expired. Default 50/50 unblocks settlement.",
        };
      }
      return {
        urgency: 'wait',
        label: `Waiting on buyer's split proposal (m${activeMilestoneIndex + 1})`,
        hint: 'Your split is on chain. Buyer needs to match it for funds to release.',
      };
    }
    return {
      urgency: 'wait',
      label: 'Waiting on buyer',
      hint: 'No provider action right now.',
    };
  }
  return { urgency: 'wait', label: status, hint: 'No provider action right now.' };
}

function pickFocusMilestone(args: {
  activeMilestoneIndex: number;
  milestones: (MilestoneStateChain | null)[];
}): number | null {
  if (args.activeMilestoneIndex !== NO_ACTIVE_MILESTONE) return args.activeMilestoneIndex;
  // No active milestone - return the first pending one (next to start).
  const next = args.milestones.findIndex((m) => {
    if (!m) return false;
    return milestoneStatusToString(m.status) === 'pending';
  });
  return next >= 0 ? next : null;
}

function pickPendingDeadline(args: {
  status: string;
  rfp: RfpChain;
  milestones: (MilestoneStateChain | null)[];
  focusIndex: number | null;
}): string | null {
  const { status, rfp, milestones, focusIndex } = args;
  if (status === 'open' && rfp.bidCloseAt > 0n) return unixSecondsToIso(rfp.bidCloseAt);
  if (status === 'reveal' && rfp.revealCloseAt > 0n) return unixSecondsToIso(rfp.revealCloseAt);
  if (status === 'awarded' && rfp.fundingDeadline > 0n)
    return unixSecondsToIso(rfp.fundingDeadline);
  if (focusIndex === null) return null;
  const m = milestones[focusIndex];
  if (!m) return null;
  if (m.reviewDeadline > 0n) return unixSecondsToIso(m.reviewDeadline);
  if (m.deliveryDeadline > 0n) return unixSecondsToIso(m.deliveryDeadline);
  if (m.disputeDeadline > 0n) return unixSecondsToIso(m.disputeDeadline);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectGroups {
  actionRequired: ProjectRow[];
  inProgress: ProjectRow[];
  done: ProjectRow[];
}

export function groupProjects(rows: ProjectRow[]): ProjectGroups {
  const out: ProjectGroups = { actionRequired: [], inProgress: [], done: [] };
  for (const r of rows) {
    if (r.nextAction.urgency === 'now') out.actionRequired.push(r);
    else if (r.nextAction.urgency === 'done') out.done.push(r);
    else out.inProgress.push(r);
  }
  // Sort each group: most-recent first within a tier.
  const byCreated = (a: ProjectRow, b: ProjectRow) => b.createdAtIso.localeCompare(a.createdAtIso);
  out.actionRequired.sort(byCreated);
  out.inProgress.sort(byCreated);
  out.done.sort(byCreated);
  return out;
}
