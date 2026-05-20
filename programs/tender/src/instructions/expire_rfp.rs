use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{Rfp, RfpExpired, RfpStatus};

/// Permissionless flip of the RFP to `RfpStatus::Expired`. Two trigger
/// conditions, both with status still `BidsClosed` or `Reveal`:
///
///   1. **Reveal window elapsed** (`now > reveal_close_at`) — the original
///      deadlock-recovery path: buyer never called `select_bid`, so the
///      RFP is stuck. Anyone can clear it.
///
///   2. **Zero bids** (`bid_count == 0`) — added 2026-05-07. When no
///      provider committed a bid before `bid_close_at`, there's literally
///      nothing to wait on. Forcing the buyer to sit through the reveal
///      window for a no-op is hostile UX. Allowed any time after bidding
///      closes.
///
/// Either way, flips status so the UI can stop surfacing dead "Award the
/// winner" actions and so future tooling can recognize the terminal state.
///
/// Rent on the Rfp account does NOT move - the account stays alive as
/// historical record (mirrors `mark_buyer_ghosted`'s pattern). The buyer
/// keeps the rent they originally paid; the caller pays only the tx fee.
/// No reputation impact for the buyer in either branch — both are
/// "nothing happened, terminate cleanly" cases.
#[derive(Accounts)]
pub struct ExpireRfp<'info> {
    /// Permissionless caller - typically the buyer (in their /me/projects
    /// "Action required" surface) or any provider with a stuck bid.
    pub caller: Signer<'info>,

    #[account(mut)]
    pub rfp: Account<'info, Rfp>,
}

#[qedgen_macros::qed(verified, spec = "../../tender.qedspec", handler = "expire_rfp", hash = "ae061276835fdec0", spec_hash = "3e28b195a1c8fcb5", accounts = "ExpireRfp", accounts_file = "src/instructions/expire_rfp.rs", accounts_hash = "a349a36258a5dbfc")]
pub fn handler(ctx: Context<ExpireRfp>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;

    // Only RFPs that closed bidding but never awarded can expire. Open RFPs
    // need to go through rfp_close_bidding first; Awarded+ has its own
    // ghost / dispute / completion paths.
    require!(
        matches!(rfp.status, RfpStatus::Reveal | RfpStatus::BidsClosed),
        TenderError::InvalidRfpStatus
    );

    // Two valid triggers — see fn-level docs for rationale.
    let now = Clock::get()?.unix_timestamp;
    require!(
        rfp.bid_count == 0 || now > rfp.reveal_close_at,
        TenderError::RevealWindowOpen
    );

    rfp.status = RfpStatus::Expired;

    emit!(RfpExpired {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        at: now,
    });
    Ok(())
}
