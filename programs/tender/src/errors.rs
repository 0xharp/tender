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
    #[msg("Funding window has expired - buyer ghosted")]
    FundingWindowExpired,
    #[msg("Funding window is still open")]
    FundingWindowOpen,
    #[msg("Review window is still open")]
    ReviewWindowOpen,
    #[msg("Review window has expired")]
    ReviewWindowExpired,
    #[msg("Cancel-with-notice period is still in effect")]
    CancelNoticeActive,
    #[msg("Dispute cool-off is still active")]
    DisputeCooloffActive,
    #[msg("Dispute cool-off has expired")]
    DisputeCooloffExpired,

    // Bid lifecycle
    #[msg("Bid commit already exists for this provider")]
    BidAlreadyCommitted,
    #[msg("Bid commit hash mismatch")]
    BidCommitHashMismatch,
    #[msg("Bid is not in a withdrawable state")]
    BidNotWithdrawable,
    #[msg("Bid is not in the expected lifecycle state for this action")]
    InvalidBidStatus,

    // Authorization
    #[msg("Signer is not the buyer")]
    NotBuyer,
    #[msg("Signer is not the provider")]
    NotProvider,
    #[msg("Signer is not a party to this dispute")]
    NotDisputeParty,
    #[msg("Signer is not the treasury authority")]
    NotTreasuryAuthority,
    #[msg("Attestation signature is invalid")]
    InvalidAttestation,

    // Input validation
    #[msg("Milestone count must be between 1 and 8")]
    InvalidMilestoneCount,
    #[msg("Milestone percentages must sum to 100")]
    InvalidMilestonePercentages,
    #[msg("Milestone index out of bounds")]
    InvalidMilestoneIndex,
    #[msg("bid_open_at must be < bid_close_at < reveal_close_at")]
    InvalidBidWindow,
    #[msg("Window value must be positive")]
    InvalidWindowSecs,
    #[msg("Max iterations must be at least 1")]
    InvalidMaxIterations,
    #[msg("Reserve commitment must reveal correctly")]
    ReserveCommitmentMismatch,
    #[msg("Winning bid exceeds the revealed reserve price")]
    WinningBidExceedsReserve,
    #[msg("Declared winning amount mismatch with bid envelope")]
    DeclaredAmountMismatch,
    #[msg("Provider declared a payout chain that V1 does not yet support")]
    CrossChainNotYetSupported,
    #[msg("Declared envelope size exceeds maximum")]
    EnvelopeTooLarge,
    #[msg("Declared envelope size must be > 0")]
    EnvelopeEmpty,
    #[msg("Split must be in 0..=10000 basis points")]
    InvalidSplit,
    #[msg("Split mismatch - both parties must propose the same split")]
    SplitMismatch,
    #[msg("Iteration count exceeded")]
    IterationsExhausted,
    #[msg("Fee bps must be <= 10000")]
    InvalidFeeBps,

    // Chunked write errors
    #[msg("Chunk offset is out of bounds for the declared envelope size")]
    ChunkOffsetOutOfBounds,
    #[msg("Chunk would write past the declared envelope size")]
    ChunkOverrun,
    #[msg("Chunk targets an unknown envelope kind (must be 0 = buyer, 1 = provider)")]
    InvalidEnvelopeKind,

    // Status transitions
    #[msg("RFP is not in a state that allows this action")]
    InvalidRfpStatus,
    #[msg("Milestone is not in the expected state for this action")]
    InvalidMilestoneStatus,
    #[msg("Another milestone is currently active - only one milestone can be in flight at a time")]
    AnotherMilestoneActive,
    #[msg("Milestone's delivery deadline has not yet passed - use cancel_with_penalty instead")]
    DeliveryDeadlineNotPassed,
    #[msg("Milestone has no delivery deadline configured - cancel_late_milestone unavailable")]
    NoDeliveryDeadline,

    // Escrow / token math
    #[msg("Token math overflow")]
    MathOverflow,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrow,
}
