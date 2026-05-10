/**
 * Pure next-action classifier — extracted from lib/me/projects.ts so
 * client surfaces can call it directly without dragging in the
 * server-only supabase / listRfps imports.
 *
 * Two consumers:
 *   - server: lib/me/projects.ts re-exports `computeNextAction` etc.
 *     and uses them from `listProjectsForWallet` for main-wallet RFPs.
 *   - client: components/me/hd-projects.tsx calls these directly to
 *     classify HD-buyer-owned RFPs from MyActivityProvider, fetching
 *     milestones per RFP from chain when needed. Same precision the
 *     server gets for main-wallet RFPs.
 *
 * No I/O. All inputs are passed in. The caller is responsible for
 * fetching the milestone state + RFP chain timestamps.
 */
import {
  type MilestoneStateChain,
  type RfpChain,
  milestoneStatusToString,
} from '@/lib/solana/chain-reads';

export type ProjectRole = 'buyer' | 'provider';

export type NextActionUrgency = 'now' | 'soon' | 'wait' | 'done';

export interface NextAction {
  urgency: NextActionUrgency;
  label: string;
  hint: string;
}

/** "No active milestone" sentinel — matches the on-chain
 *  `Rfp::active_milestone_index = 255` placeholder. */
export const NO_ACTIVE_MILESTONE = 255;

/** "Not proposed" sentinel for milestone split bps fields (see escrow.rs). */
const SPLIT_NOT_PROPOSED = 0xffff;

/** Safe bigint→ms conversion. 0n means "not set" → returns null. */
function deadlineMs(secs: bigint): number | null {
  if (secs === 0n) return null;
  return Number(secs) * 1000;
}

export interface ComputeNextActionInput {
  role: ProjectRole;
  status: string;
  activeMilestoneIndex: number;
  milestones: (MilestoneStateChain | null)[];
  bidCloseAtMs: number;
  revealCloseAtMs: number;
  fundingDeadlineMs: number | null;
  nowMs: number;
  /** On-chain `rfp.bid_count`. When 0 in the bidsclosed/reveal phase,
   *  there's nothing to award — surface a clearer "no bids" state instead
   *  of the misleading "Award the winner" prompt. */
  bidCount: number;
}

export function computeNextAction(args: ComputeNextActionInput): NextAction {
  const {
    role,
    status,
    activeMilestoneIndex,
    milestones,
    bidCloseAtMs,
    revealCloseAtMs,
    fundingDeadlineMs,
    nowMs,
    bidCount,
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
      if (nowMs > revealCloseAtMs) {
        return {
          urgency: 'now',
          label: 'Mark RFP expired',
          hint:
            bidCount === 0
              ? 'No bids were received. Mark expired to terminate cleanly — no reputation impact.'
              : 'Reveal window closed without an award. Run expire_rfp to terminate the RFP cleanly.',
        };
      }
      if (bidCount === 0) {
        return {
          urgency: 'now',
          label: 'Mark RFP expired',
          hint: 'No bids were received. Mark expired to terminate cleanly — no reputation impact since nothing was committed to.',
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
        if (disputeMs && nowMs > disputeMs && !providerSet) {
          return {
            urgency: 'now',
            label: `Apply default 50/50 (milestone ${focus! + 1})`,
            hint: 'Cool-off expired without a matching split from the provider. Default 50/50 is the only on-chain way out.',
          };
        }
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
      if (disputeMs && nowMs > disputeMs && !buyerSet) {
        return {
          urgency: 'now',
          label: `Apply default 50/50 (milestone ${activeMilestoneIndex + 1})`,
          hint: 'Cool-off expired without a matching split from the buyer. Default 50/50 is the only on-chain way out.',
        };
      }
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

export function pickFocusMilestone(args: {
  activeMilestoneIndex: number;
  milestones: (MilestoneStateChain | null)[];
}): number | null {
  if (args.activeMilestoneIndex !== NO_ACTIVE_MILESTONE) return args.activeMilestoneIndex;
  const next = args.milestones.findIndex((m) => {
    if (!m) return false;
    return milestoneStatusToString(m.status) === 'pending';
  });
  return next >= 0 ? next : null;
}

export function pickPendingDeadline(args: {
  status: string;
  rfp: RfpChain;
  milestones: (MilestoneStateChain | null)[];
  focusIndex: number | null;
}): number | null {
  const { status, rfp, milestones, focusIndex } = args;
  if (status === 'open' && rfp.bidCloseAt > 0n) return Number(rfp.bidCloseAt) * 1000;
  if (status === 'reveal' && rfp.revealCloseAt > 0n) return Number(rfp.revealCloseAt) * 1000;
  if (status === 'awarded' && rfp.fundingDeadline > 0n) return Number(rfp.fundingDeadline) * 1000;
  if (focusIndex === null) return null;
  const m = milestones[focusIndex];
  if (!m) return null;
  if (m.reviewDeadline > 0n) return Number(m.reviewDeadline) * 1000;
  if (m.deliveryDeadline > 0n) return Number(m.deliveryDeadline) * 1000;
  if (m.disputeDeadline > 0n) return Number(m.disputeDeadline) * 1000;
  return null;
}
