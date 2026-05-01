use anchor_lang::prelude::*;

pub const MIN_MILESTONE_COUNT: u8 = 1;
pub const MAX_MILESTONE_COUNT: u8 = 8;

#[account]
#[derive(InitSpace)]
pub struct Rfp {
    pub buyer: Pubkey,
    pub buyer_encryption_pubkey: [u8; 32],
    pub title_hash: [u8; 32],
    pub category: u8,
    pub budget_max: u64,
    pub bid_open_at: i64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
    pub bidder_visibility: BidderVisibility,
    pub status: RfpStatus,
    pub winner: Option<Pubkey>,
    pub escrow_vault: Pubkey,
    pub bid_count: u32,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum RfpStatus {
    Draft,
    Open,
    Reveal,
    Awarded,
    InProgress,
    Completed,
    Disputed,
    Cancelled,
}

/// Per-RFP bidder identity privacy level.
/// See `docs/PRIVACY-MODEL.md` for the full rationale.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidderVisibility {
    /// L0 — anyone can enumerate which providers bid on this RFP.
    /// `BidCommit` PDA seed includes the provider wallet; identity stored as `Plain(Pubkey)`.
    Public,
    /// L1 — only the buyer (after the bid window closes) can see who bid.
    /// `BidCommit` PDA seed uses a provider-derived nonce; identity stored as `Hashed([u8; 32])`.
    BuyerOnly,
}

#[event]
pub struct RfpCreated {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub category: u8,
    pub budget_max: u64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
    pub bidder_visibility: BidderVisibility,
}

#[event]
pub struct RfpClosed {
    pub rfp: Pubkey,
    pub bid_count: u32,
    pub closed_at: i64,
}
