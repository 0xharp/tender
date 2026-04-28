use anchor_lang::prelude::*;

#[error_code]
pub enum TenderError {
    // Time-window errors
    #[msg("Bid window not yet open")]
    BidWindowNotOpen,
    #[msg("Bid window has closed")]
    BidWindowClosed,
    #[msg("Bid window is still open")]
    BidWindowStillOpen,
    #[msg("Reveal window has expired")]
    RevealWindowExpired,

    // Bid lifecycle
    #[msg("Bid commit already exists for this provider")]
    BidAlreadyCommitted,
    #[msg("Bid commit hash mismatch")]
    BidCommitHashMismatch,
    #[msg("Bid is not in a withdrawable state")]
    BidNotWithdrawable,

    // Authorization
    #[msg("Signer is not the buyer")]
    NotBuyer,
    #[msg("Signer is not the provider")]
    NotProvider,

    // Input validation
    #[msg("Milestone count must be between 1 and 8")]
    InvalidMilestoneCount,
    #[msg("bid_open_at must be < bid_close_at < reveal_close_at")]
    InvalidBidWindow,
    #[msg("Ciphertext storage URI exceeds maximum length")]
    UriTooLong,
    #[msg("Budget must be greater than zero")]
    InvalidBudget,

    // Status transitions
    #[msg("RFP is not in a state that allows this action")]
    InvalidRfpStatus,
}
