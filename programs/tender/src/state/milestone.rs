use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct MilestoneState {
    pub rfp: Pubkey,
    pub index: u8,
    pub amount: u64,                 // sourced from rfp.milestone_amounts[index] at fund_project
    pub status: MilestoneStatus,
    pub iteration_count: u8,         // # of REQUEST_CHANGES so far
    pub started_at: i64,             // 0 if not started
    pub submitted_at: i64,           // 0 if not submitted
    pub review_deadline: i64,        // submitted_at + review_window_secs (auto-release at this time)
    pub disputed_at: i64,            // 0 if not in dispute
    pub dispute_deadline: i64,       // disputed_at + dispute_cooloff_secs
    pub bump: u8,

    /// Off-platform settlement intent: each party can sign a (party, split_to_provider_bps) pair.
    /// When BOTH parties have signed the SAME split, `resolve_dispute` releases per agreement.
    pub buyer_proposed_split_bps: u16,    // 0-10000, 10000 = MAX (sentinel for "not yet proposed")
    pub provider_proposed_split_bps: u16,

    /// Provider's commitment-by-deadline. Set in `start_milestone` from
    /// `started_at + rfp.milestone_durations_secs[index]`. 0 if no deadline
    /// was specified in the bid (legacy bids without per-milestone duration).
    /// After this passes (and status is still Started), the buyer can call
    /// `cancel_late_milestone` for a no-penalty refund.
    pub delivery_deadline: i64,
}

pub const MILESTONE_SEED: &[u8] = b"milestone";
pub const SPLIT_NOT_PROPOSED: u16 = u16::MAX;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MilestoneStatus {
    Pending,         // funded, not yet started by provider
    Started,         // provider committed; cancel-with-penalty applies
    Submitted,       // provider submitted; review window counting down
    Accepted,        // buyer accepted (or auto-released); about to release
    Released,        // funds dispatched
    Disputed,        // dispute cool-off ticking
    DisputeResolved, // both parties agreed on a split, funds released per agreement
    DisputeDefault,  // cool-off expired, 50/50 split applied
    CancelledByBuyer,
}

#[event]
pub struct MilestoneStarted {
    pub rfp: Pubkey,
    pub index: u8,
    pub provider: Pubkey,
    pub at: i64,
}

#[event]
pub struct MilestoneSubmitted {
    pub rfp: Pubkey,
    pub index: u8,
    pub at: i64,
    pub review_deadline: i64,
    pub iteration: u8,
}

#[event]
pub struct MilestoneAccepted {
    pub rfp: Pubkey,
    pub index: u8,
    pub at: i64,
    pub auto_released: bool,
    pub amount_to_provider: u64,
    pub fee_to_treasury: u64,
}

#[event]
pub struct MilestoneChangesRequested {
    pub rfp: Pubkey,
    pub index: u8,
    pub at: i64,
    pub iteration: u8,
}

#[event]
pub struct MilestoneRejected {
    pub rfp: Pubkey,
    pub index: u8,
    pub at: i64,
    pub dispute_deadline: i64,
}

#[event]
pub struct MilestoneCancelled {
    pub rfp: Pubkey,
    pub index: u8,
    pub at: i64,
    pub refund_to_buyer: u64,
    pub penalty_to_provider: u64,
    pub kind: u8,                   // 0 = with notice (un-started), 1 = with penalty (started)
}

#[event]
pub struct DisputeSplitProposed {
    pub rfp: Pubkey,
    pub index: u8,
    pub party: Pubkey,
    pub split_to_provider_bps: u16,
    pub at: i64,
}

#[event]
pub struct DisputeResolved {
    pub rfp: Pubkey,
    pub index: u8,
    pub split_to_provider_bps: u16,
    pub provider_amount: u64,
    pub buyer_refund: u64,
    pub fee_to_treasury: u64,
    pub at: i64,
    pub default_applied: bool,      // true if 50/50 default fired
}
