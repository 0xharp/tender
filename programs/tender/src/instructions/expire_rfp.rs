use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{Rfp, RfpExpired, RfpStatus};

/// Permissionless after `rfp.reveal_close_at` expires while status is still
/// `BidsClosed` or `Reveal` (i.e., the buyer never called `select_bid`).
/// Flips the RFP to `RfpStatus::Expired` so the UI can stop surfacing
/// dead "Award the winner" actions and so future tooling can recognize
/// the terminal state.
///
/// Rent on the Rfp account does NOT move - the account stays alive as
/// historical record (mirrors `mark_buyer_ghosted`'s pattern). The buyer
/// keeps the rent they originally paid; the caller pays only the tx fee.
#[derive(Accounts)]
pub struct ExpireRfp<'info> {
    /// Permissionless caller - typically the buyer (in their /me/projects
    /// "Action required" surface) or any provider with a stuck bid.
    pub caller: Signer<'info>,

    #[account(mut)]
    pub rfp: Account<'info, Rfp>,
}

pub fn handler(ctx: Context<ExpireRfp>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;

    // Only RFPs that closed bidding but never awarded can expire. Open RFPs
    // need to go through rfp_close_bidding first; Awarded+ has its own
    // ghost / dispute / completion paths.
    require!(
        matches!(rfp.status, RfpStatus::Reveal | RfpStatus::BidsClosed),
        TenderError::InvalidRfpStatus
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now > rfp.reveal_close_at, TenderError::RevealWindowOpen);

    rfp.status = RfpStatus::Expired;

    emit!(RfpExpired {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        at: now,
    });
    Ok(())
}
