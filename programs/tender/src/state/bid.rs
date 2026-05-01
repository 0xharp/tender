use anchor_lang::prelude::*;

/// Maximum permitted size for a single ECIES envelope (buyer or provider copy).
/// Sets an absolute upper bound on bid plaintext size; in practice the provider
/// declares the actual size at `commit_bid_init` and only that much is allocated.
pub const MAX_ENVELOPE_LEN: u32 = 64 * 1024; // 64 KiB per envelope, 128 KiB combined

/// Domain-separation prefix for the symmetric-key derivation message providers
/// sign when generating a per-RFP `bid_pda_seed` in `BuyerOnly` mode. Kept here
/// so the on-chain program and the web client agree on the literal bytes.
pub const BID_PDA_SEED_DOMAIN: &[u8] = b"tender-bid-seed-v1";

/// Identity binding for a `BidCommit`. The variant is fixed by the parent RFP's
/// `bidder_visibility` at `commit_bid_init` time and used by `withdraw_bid` /
/// `select_bid` to authenticate the signer.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProviderIdentity {
    /// L0 — provider's wallet stored in the clear.
    Plain(Pubkey),
    /// L1 — only `sha256(provider_wallet)` is stored. Authenticate by hashing the signer.
    Hashed([u8; 32]),
}

/// On-chain bid record. Allocated on the base layer in `commit_bid_init`, then
/// delegated to MagicBlock PER (with a paired permission account) so envelope
/// reads are gated by the TEE-backed validator. Both ECIES envelopes are written
/// in via `write_bid_chunk` calls on the ER, then sealed in `finalize_bid`.
///
/// Account layout is variable-length: fixed fields + two `Vec<u8>` envelopes
/// whose maximum sizes are declared at init via `BidCommitInitArgs`. We do NOT
/// use `#[derive(InitSpace)]` because the envelope sizes vary per bid; size is
/// computed by `BidCommit::space(buyer_envelope_len, provider_envelope_len)`.
#[account]
pub struct BidCommit {
    /// The RFP this bid is for.
    pub rfp: Pubkey,
    /// Snapshot of the parent RFP's `buyer` at init time. Stored locally so the
    /// ER-side `open_reveal_window` ix can build the new permission set without
    /// having to read the base-layer Rfp account.
    pub buyer: Pubkey,
    /// Snapshot of the parent RFP's `bid_close_at` at init time. Used by
    /// `open_reveal_window` to enforce the time gate without a base-layer read.
    pub bid_close_at: i64,
    /// PDA seed bytes used at init (`[b"bid", rfp, bid_pda_seed]`). In L0 mode
    /// equals `provider_wallet.to_bytes()`; in L1 mode equals
    /// `sha256(walletSig(BID_PDA_SEED_DOMAIN || rfp_nonce))`.
    pub bid_pda_seed: [u8; 32],
    /// Provider identity binding — see `ProviderIdentity`.
    pub provider_identity: ProviderIdentity,
    /// `sha256(buyer_envelope || provider_envelope)`. Verified at `finalize_bid`.
    pub commit_hash: [u8; 32],
    /// Declared size of `buyer_envelope` at init. Used by `write_bid_chunk` to
    /// validate offsets and by `finalize_bid` to know the slice bounds.
    pub buyer_envelope_len: u32,
    /// Declared size of `provider_envelope` at init.
    pub provider_envelope_len: u32,
    /// ECIES envelope encrypted to the buyer's RFP-specific X25519 pubkey.
    /// Populated by `write_bid_chunk` calls on the ER, sealed by `finalize_bid`.
    pub buyer_envelope: Vec<u8>,
    /// ECIES envelope encrypted to the provider's per-wallet X25519 pubkey.
    /// Same flow as `buyer_envelope`.
    pub provider_envelope: Vec<u8>,
    pub submitted_at: i64,
    pub status: BidStatus,
    pub bump: u8,
}

impl BidCommit {
    /// Fixed bytes consumed by everything except the two envelope `Vec<u8>` payloads.
    /// Layout: 8 disc + 32 rfp + 32 buyer + 8 bid_close_at + 32 bid_pda_seed
    ///       + (1 tag + 32) provider_identity + 32 commit_hash
    ///       + 4 buyer_envelope_len + 4 provider_envelope_len
    ///       + 4 vec_len_buyer + 4 vec_len_provider + 8 submitted_at + 1 status + 1 bump
    pub const FIXED_SPACE: usize =
        8 + 32 + 32 + 8 + 32 + (1 + 32) + 32 + 4 + 4 + 4 + 4 + 8 + 1 + 1;

    /// Total account allocation given declared envelope sizes.
    pub fn space(buyer_envelope_len: u32, provider_envelope_len: u32) -> usize {
        Self::FIXED_SPACE + buyer_envelope_len as usize + provider_envelope_len as usize
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BidStatus {
    /// Account allocated + delegated; envelope chunks still being written.
    Initializing,
    /// All chunks written, `commit_hash` verified, account sealed for reading.
    Committed,
    /// Buyer picked this bid as the winner.
    Selected,
    /// Provider withdrew before `bid_close_at`.
    Withdrawn,
    /// Reveal window expired without selection.
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

/// Emitted by `close_withdrawn_bid` after the post-undelegate base-layer close.
/// Distinct from `BidWithdrawn` (which fires during the ER-side status flip) so
/// downstream indexers can tell "withdrawn but rent still locked" from
/// "withdrawn AND rent reclaimed".
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
