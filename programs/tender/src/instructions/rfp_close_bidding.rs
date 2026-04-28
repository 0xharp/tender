use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{Rfp, RfpClosed, RfpStatus};

#[derive(Accounts)]
pub struct RfpCloseBidding<'info> {
    pub anyone: Signer<'info>,

    #[account(mut)]
    pub rfp: Account<'info, Rfp>,
}

pub fn handler(ctx: Context<RfpCloseBidding>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Open, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= rfp.bid_close_at, TenderError::BidWindowStillOpen);

    rfp.status = RfpStatus::Reveal;

    emit!(RfpClosed {
        rfp: rfp.key(),
        bid_count: rfp.bid_count,
        closed_at: now,
    });

    Ok(())
}
