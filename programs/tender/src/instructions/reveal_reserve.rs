use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::errors::TenderError;
use crate::state::{Rfp, RfpStatus};

/// Buyer reveals the reserve price they committed to at RFP create time.
/// SHA-256(amount_le_bytes(8) || nonce(32)) must match `rfp.reserve_price_commitment`.
///
/// After this ix, providers + observers know the reserve, and `select_bid` can
/// enforce `winning_bid <= reserve` on chain. Skippable if no reserve was set
/// (commitment all zeros).
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RevealReserveArgs {
    pub reserve_amount: u64,
    pub reserve_nonce: [u8; 32],
}

#[derive(Accounts)]
pub struct RevealReserve<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Account<'info, Rfp>,
}

pub fn handler(ctx: Context<RevealReserve>, args: RevealReserveArgs) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Reveal | RfpStatus::BidsClosed),
        TenderError::InvalidRfpStatus
    );
    require!(rfp.reserve_price_commitment != [0u8; 32], TenderError::ReserveCommitmentMismatch);

    let computed = hashv(&[&args.reserve_amount.to_le_bytes(), &args.reserve_nonce]).to_bytes();
    require!(computed == rfp.reserve_price_commitment, TenderError::ReserveCommitmentMismatch);

    rfp.reserve_price_revealed = args.reserve_amount;
    Ok(())
}
