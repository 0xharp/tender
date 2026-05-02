use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Rfp, RfpGhosted, RfpStatus,
};

/// Permissionless after `rfp.funding_deadline` expires with no `fund_project`
/// call. Marks the buyer as ghosted and bumps reputation. RFP -> GhostedByBuyer.
#[derive(Accounts)]
pub struct MarkBuyerGhosted<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub rfp: Box<Account<'info, Rfp>>,

    #[account(
        mut,
        seeds = [BUYER_REP_SEED, rfp.buyer.as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,
}

pub fn handler(ctx: Context<MarkBuyerGhosted>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Awarded, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now > rfp.funding_deadline, TenderError::FundingWindowOpen);

    rfp.status = RfpStatus::GhostedByBuyer;

    let rep = &mut ctx.accounts.buyer_reputation;
    rep.ghosted_rfps = rep.ghosted_rfps.saturating_add(1);
    rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: rep.buyer, field: 3, at: now });

    emit!(RfpGhosted { rfp: rfp.key(), buyer: rfp.buyer, at: now });
    Ok(())
}
