use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidSelected, BidStatus, Rfp, RfpStatus};

#[derive(Accounts)]
pub struct SelectBid<'info> {
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Account<'info, Rfp>,

    #[account(
        mut,
        constraint = bid.rfp == rfp.key() @ TenderError::InvalidRfpStatus,
        seeds = [b"bid", rfp.key().as_ref(), bid.provider.as_ref()],
        bump = bid.bump,
    )]
    pub bid: Account<'info, BidCommit>,
}

pub fn handler(ctx: Context<SelectBid>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let bid = &mut ctx.accounts.bid;

    require!(rfp.status == RfpStatus::Reveal, TenderError::InvalidRfpStatus);
    require!(
        bid.status == BidStatus::Committed,
        TenderError::InvalidRfpStatus
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < rfp.reveal_close_at, TenderError::RevealWindowExpired);

    rfp.winner = Some(bid.provider);
    rfp.status = RfpStatus::Awarded;
    bid.status = BidStatus::Selected;

    emit!(BidSelected {
        rfp: rfp.key(),
        bid: bid.key(),
        buyer: rfp.buyer,
        provider: bid.provider,
        selected_at: now,
    });

    Ok(())
}
