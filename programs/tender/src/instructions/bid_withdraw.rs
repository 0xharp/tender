use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidStatus, BidWithdrawn, Rfp};

#[derive(Accounts)]
pub struct BidWithdrawIx<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        constraint = rfp.key() == bid.rfp,
    )]
    pub rfp: Account<'info, Rfp>,

    #[account(
        mut,
        close = provider,
        seeds = [b"bid", rfp.key().as_ref(), provider.key().as_ref()],
        bump = bid.bump,
        has_one = provider @ TenderError::NotProvider,
    )]
    pub bid: Account<'info, BidCommit>,
}

pub fn handler(ctx: Context<BidWithdrawIx>) -> Result<()> {
    let bid = &ctx.accounts.bid;
    let rfp = &mut ctx.accounts.rfp;

    require!(
        bid.status == BidStatus::Committed,
        TenderError::BidNotWithdrawable
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < rfp.bid_close_at, TenderError::BidWindowClosed);

    rfp.bid_count = rfp.bid_count.saturating_sub(1);

    emit!(BidWithdrawn {
        bid: bid.key(),
        rfp: rfp.key(),
        provider: bid.provider,
        withdrawn_at: now,
    });

    Ok(())
}
