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

#[event]
pub struct RfpCreated {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub category: u8,
    pub budget_max: u64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
}

#[event]
pub struct RfpClosed {
    pub rfp: Pubkey,
    pub bid_count: u32,
    pub closed_at: i64,
}
