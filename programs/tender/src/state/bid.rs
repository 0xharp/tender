use anchor_lang::prelude::*;

pub const MAX_ENVELOPE_LEN: u32 = 64 * 1024;

/// Where milestone payments land for this bid.
///
/// V1 only `Solana { mint }` is implemented. `CrossChain` is reserved for the
/// Day 10 Ika integration - `select_bid` rejects it with `CrossChainNotYetSupported`
/// for now, so the on-chain shape is forward-compat without breaking changes.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum PayoutChain {
    Solana { mint: Pubkey },
    CrossChain { ika_dwallet_id: [u8; 32], target_chain: TargetChain },
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TargetChain {
    Bitcoin,
    Ethereum,
    Sui,
    Other(u16),
}

#[account]
pub struct BidCommit {
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub bid_close_at: i64,
    /// The pubkey that signed `commit_bid_init`. Bid PDA is derived from this.
    /// In public-bidder-list RFPs this is the provider's main wallet.
    /// In private-bidder-list RFPs this is a per-(main_wallet, rfp) deterministic
    /// ephemeral wallet - the provider's main wallet does not appear on chain.
    pub provider: Pubkey,
    pub commit_hash: [u8; 32],
    pub buyer_envelope_len: u32,
    pub provider_envelope_len: u32,
    pub buyer_envelope: Vec<u8>,
    pub provider_envelope: Vec<u8>,
    pub submitted_at: i64,
    pub status: BidStatus,
    pub bump: u8,

    /// Where milestone USDC lands at release time. Set at `commit_bid_init`.
    /// In public mode = `provider`. In private mode = `provider` (the ephemeral)
    /// initially; gets set to the verified main wallet at `select_bid` time.
    pub payout_destination: Pubkey,

    /// Payout currency + chain. V1 = `Solana { mint: USDC }` only.
    pub payout_chain: PayoutChain,
}

impl BidCommit {
    /// 8 disc + 32 rfp + 32 buyer + 8 bid_close_at + 32 provider + 32 commit_hash
    /// + 4 buyer_envelope_len + 4 provider_envelope_len
    /// + 4 + 4 vec lens + 8 submitted_at + 1 status + 1 bump
    /// + 32 payout_destination
    /// + 1 + 64 payout_chain (1 disc + max 64 for CrossChain variant)
    pub const FIXED_SPACE: usize =
        8 + 32 + 32 + 8 + 32 + 32 + 4 + 4 + 4 + 4 + 8 + 1 + 1 + 32 + (1 + 64);

    pub fn space(buyer_envelope_len: u32, provider_envelope_len: u32) -> usize {
        Self::FIXED_SPACE + buyer_envelope_len as usize + provider_envelope_len as usize
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidStatus {
    Initializing,
    Committed,
    Selected,
    Withdrawn,
    Expired,
}

#[event]
pub struct BidInitialized {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub buyer_envelope_len: u32,
    pub provider_envelope_len: u32,
    pub initialized_at: i64,
}

#[event]
pub struct BidCommitted {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub commit_hash: [u8; 32],
    pub committed_at: i64,
}

#[event]
pub struct BidWithdrawn {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub withdrawn_at: i64,
}

#[event]
pub struct BidClosed {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub provider: Pubkey,
    pub closed_at: i64,
}

#[event]
pub struct BidSelected {
    pub rfp: Pubkey,
    pub bid: Pubkey,
    pub buyer: Pubkey,
    pub provider: Pubkey,
    pub selected_at: i64,
}

#[event]
pub struct RevealWindowOpened {
    pub bid: Pubkey,
    pub rfp: Pubkey,
    pub buyer: Pubkey,
    pub opened_at: i64,
}
