use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    BidCommit, BidCommitted, BidStatus, MAX_CIPHERTEXT_URI_LEN, Rfp, RfpStatus,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitBidArgs {
    pub commit_hash: [u8; 32],
    pub ciphertext_storage_uri: String,
}

#[derive(Accounts)]
#[instruction(args: CommitBidArgs)]
pub struct CommitBid<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
    pub rfp: Account<'info, Rfp>,

    #[account(
        init,
        payer = provider,
        space = 8 + BidCommit::INIT_SPACE,
        seeds = [b"bid", rfp.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub bid: Account<'info, BidCommit>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CommitBid>, args: CommitBidArgs) -> Result<()> {
    require!(
        args.ciphertext_storage_uri.len() <= MAX_CIPHERTEXT_URI_LEN,
        TenderError::UriTooLong
    );

    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Open, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= rfp.bid_open_at, TenderError::BidWindowNotOpen);
    require!(now < rfp.bid_close_at, TenderError::BidWindowClosed);

    let bid = &mut ctx.accounts.bid;
    bid.rfp = rfp.key();
    bid.provider = ctx.accounts.provider.key();
    bid.commit_hash = args.commit_hash;
    bid.ciphertext_storage_uri = args.ciphertext_storage_uri;
    bid.submitted_at = now;
    bid.status = BidStatus::Committed;
    bid.bump = ctx.bumps.bid;

    rfp.bid_count = rfp.bid_count.saturating_add(1);

    emit!(BidCommitted {
        bid: bid.key(),
        rfp: rfp.key(),
        provider: bid.provider,
        commit_hash: bid.commit_hash,
        submitted_at: bid.submitted_at,
    });

    Ok(())
}
