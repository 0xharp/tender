use anchor_lang::prelude::*;

pub const MIN_MILESTONE_COUNT: u8 = 1;
pub const MAX_MILESTONE_COUNT: u8 = 8;

/// Default per-RFP windows. Buyer overrides at create time.
pub const DEFAULT_FUNDING_WINDOW_SECS: i64 = 3 * 86_400;
pub const DEFAULT_REVIEW_WINDOW_SECS: i64 = 7 * 86_400;
pub const DEFAULT_DISPUTE_COOLOFF_SECS: i64 = 14 * 86_400;
pub const DEFAULT_CANCEL_NOTICE_SECS: i64 = 3 * 86_400;
pub const DEFAULT_MAX_ITERATIONS: u8 = 2;

/// Platform take rate (basis points). 250 = 2.5%.
pub const PLATFORM_FEE_BPS: u16 = 250;
pub const BPS_DENOMINATOR: u16 = 10_000;

/// 50% penalty for buyer-abandons-mid-flight on a started milestone.
pub const ABANDON_PENALTY_BPS: u16 = 5_000;

/// Sentinel for `Rfp.active_milestone_index` meaning "no milestone is in flight".
/// Valid milestone indices are 0..MAX_MILESTONE_COUNT-1, so 255 is unambiguous.
pub const NO_ACTIVE_MILESTONE: u8 = 255;

#[account]
#[derive(InitSpace)]
pub struct Rfp {
    pub buyer: Pubkey,
    pub buyer_encryption_pubkey: [u8; 32],
    pub title_hash: [u8; 32],
    pub category: u8,
    pub bid_open_at: i64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
    pub bidder_visibility: BidderVisibility,
    pub status: RfpStatus,
    pub winner: Option<Pubkey>,                  // BidCommit PDA of winner
    pub winner_provider: Option<Pubkey>,         // payout_destination from winning bid
    pub contract_value: u64,                     // = winning bid amount (locked at fund time)
    pub bid_count: u32,
    pub created_at: i64,
    pub bump: u8,

    /// SHA-256 commitment of the buyer's reserve price + nonce (sealed during bidding,
    /// revealed at `open_reveal_window`). 32 bytes of zero = no reserve.
    pub reserve_price_commitment: [u8; 32],
    /// Revealed reserve price (after open_reveal_window). 0 if no reserve.
    pub reserve_price_revealed: u64,

    /// Per-RFP windows. Set at create with sane defaults.
    pub funding_window_secs: i64,
    pub review_window_secs: i64,
    pub dispute_cooloff_secs: i64,
    pub cancel_notice_secs: i64,
    pub max_iterations: u8,

    /// Per-milestone payout amounts (USDC base units). Sum equals
    /// `contract_value`. Length is `milestone_count`; padded with zeros to
    /// `MAX_MILESTONE_COUNT`. Sourced from the winning bid's plaintext at
    /// `select_bid` time and used directly by `fund_project` to initialize
    /// each milestone's amount - no percentage-rounding loss.
    pub milestone_amounts: [u64; MAX_MILESTONE_COUNT as usize],

    /// Per-milestone delivery deadline duration (seconds, from the moment the
    /// provider calls `start_milestone`). Sourced from the winning bid's
    /// plaintext at `select_bid` time. Length is `milestone_count`; padded
    /// with zeros. A value of 0 means "no deadline enforced" - the
    /// `cancel_late_milestone` path is unavailable for that milestone.
    pub milestone_durations_secs: [i64; MAX_MILESTONE_COUNT as usize],

    /// Sentinel pointer to the milestone currently in flight (Started OR
    /// Submitted). Provider can only have ONE milestone active at a time;
    /// `start_milestone` requires this == NO_ACTIVE_MILESTONE and sets it to
    /// the index. `accept_milestone` / cancel paths / dispute resolve clear
    /// it back. Use `NO_ACTIVE_MILESTONE` (255) since valid indices are 0..8.
    pub active_milestone_index: u8,

    /// Set when status -> Awarded; deadline for buyer to call fund_project.
    pub funding_deadline: i64,

    /// Take rate at which milestone releases route to Treasury (basis points).
    /// Stored per-RFP so buyer can be on a different tier in the future.
    pub fee_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RfpStatus {
    Draft,
    Open,
    BidsClosed,
    Reveal,
    Awarded,        // winner picked but not yet funded
    Funded,         // escrow funded, no milestones started yet
    InProgress,     // at least one milestone started
    Completed,      // all milestones released
    Cancelled,
    GhostedByBuyer, // buyer selected but never funded within window
    Disputed,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidderVisibility {
    Public,
    BuyerOnly,
}

#[event]
pub struct RfpCreated {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub category: u8,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
    pub bidder_visibility: BidderVisibility,
    pub has_reserve: bool,
}

#[event]
pub struct RfpClosed {
    pub rfp: Pubkey,
    pub bid_count: u32,
    pub closed_at: i64,
}

#[event]
pub struct WinnerRecorded {
    pub rfp: Pubkey,
    pub bid: Pubkey,
    pub buyer: Pubkey,
    pub winner_provider: Pubkey,
    pub contract_value: u64,
    pub funding_deadline: i64,
}

#[event]
pub struct RfpFunded {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub contract_value: u64,
    pub funded_at: i64,
}

#[event]
pub struct RfpGhosted {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub at: i64,
}

#[event]
pub struct RfpCompleted {
    pub rfp: Pubkey,
    pub at: i64,
}
