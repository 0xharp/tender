use anchor_lang::prelude::*;

pub const MAX_CIPHERTEXT_URI_LEN: usize = 200;

#[account]
#[derive(InitSpace)]
pub struct BidCommit {
    pub rfp: Pubkey,
    pub provider: Pubkey,
    pub commit_hash: [u8; 32],
    #[max_len(MAX_CIPHERTEXT_URI_LEN)]
    pub ciphertext_storage_uri: String,
    pub submitted_at: i64,
    pub status: BidStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidStatus {
    Committed,
    Revealed,
    Selected,
    Rejected,
    Withdrawn,
    Expired,
}

#[event]
pub struct BidCommitted {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub provider: Pubkey,
    pub commit_hash: [u8; 32],
    pub submitted_at: i64,
}

#[event]
pub struct BidWithdrawn {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub provider: Pubkey,
    pub withdrawn_at: i64,
}
