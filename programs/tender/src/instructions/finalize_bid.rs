use anchor_lang::prelude::*;
use solana_sha256_hasher::Hasher;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidCommitted, BidStatus};

/// Phase 4 of bid submission (runs on the ER, called once after all chunks).
///
/// Verifies that `sha256(buyer_envelope || provider_envelope)` matches the
/// `commit_hash` declared at `commit_bid_init`, then flips the status from
/// `Initializing` → `Committed`. After this point the bid is sealed and
/// readable by the permission set (provider always; buyer once `open_reveal_window`
/// fires after `bid_close_at`).
#[derive(Accounts)]
pub struct FinalizeBid<'info> {
    pub provider: Signer<'info>,

    #[account(mut)]
    pub bid: Account<'info, BidCommit>,
}

pub fn handler(ctx: Context<FinalizeBid>) -> Result<()> {
    let bid = &mut ctx.accounts.bid;
    require!(
        bid.status == BidStatus::Initializing,
        TenderError::InvalidBidStatus
    );
    require!(
        bid.buyer_envelope.len() == bid.buyer_envelope_len as usize,
        TenderError::ChunkOverrun
    );
    require!(
        bid.provider_envelope.len() == bid.provider_envelope_len as usize,
        TenderError::ChunkOverrun
    );

    let mut hasher = Hasher::default();
    hasher.hash(&bid.buyer_envelope);
    hasher.hash(&bid.provider_envelope);
    let computed = hasher.result().to_bytes();
    require!(
        computed == bid.commit_hash,
        TenderError::BidCommitHashMismatch
    );

    bid.status = BidStatus::Committed;

    let now = Clock::get()?.unix_timestamp;
    emit!(BidCommitted {
        bid: bid.key(),
        rfp: bid.rfp,
        commit_hash: bid.commit_hash,
        committed_at: now,
    });

    Ok(())
}
