use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{MAX_MILESTONE_COUNT, MIN_MILESTONE_COUNT, Rfp, RfpCreated, RfpStatus};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RfpCreateArgs {
    pub rfp_nonce: [u8; 8],
    pub buyer_encryption_pubkey: [u8; 32],
    pub title_hash: [u8; 32],
    pub category: u8,
    pub budget_max: u64,
    pub bid_open_at: i64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub milestone_count: u8,
}

#[derive(Accounts)]
#[instruction(args: RfpCreateArgs)]
pub struct RfpCreate<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Rfp::INIT_SPACE,
        seeds = [b"rfp", buyer.key().as_ref(), args.rfp_nonce.as_ref()],
        bump,
    )]
    pub rfp: Account<'info, Rfp>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RfpCreate>, args: RfpCreateArgs) -> Result<()> {
    require!(args.budget_max > 0, TenderError::InvalidBudget);
    require!(
        args.milestone_count >= MIN_MILESTONE_COUNT
            && args.milestone_count <= MAX_MILESTONE_COUNT,
        TenderError::InvalidMilestoneCount
    );
    require!(
        args.bid_open_at < args.bid_close_at && args.bid_close_at < args.reveal_close_at,
        TenderError::InvalidBidWindow
    );

    let now = Clock::get()?.unix_timestamp;
    let rfp = &mut ctx.accounts.rfp;
    rfp.buyer = ctx.accounts.buyer.key();
    rfp.buyer_encryption_pubkey = args.buyer_encryption_pubkey;
    rfp.title_hash = args.title_hash;
    rfp.category = args.category;
    rfp.budget_max = args.budget_max;
    rfp.bid_open_at = args.bid_open_at;
    rfp.bid_close_at = args.bid_close_at;
    rfp.reveal_close_at = args.reveal_close_at;
    rfp.milestone_count = args.milestone_count;
    rfp.status = RfpStatus::Open;
    rfp.winner = None;
    rfp.escrow_vault = Pubkey::default();
    rfp.bid_count = 0;
    rfp.created_at = now;
    rfp.bump = ctx.bumps.rfp;

    emit!(RfpCreated {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        category: rfp.category,
        budget_max: rfp.budget_max,
        bid_close_at: rfp.bid_close_at,
        reveal_close_at: rfp.reveal_close_at,
        milestone_count: rfp.milestone_count,
    });

    Ok(())
}
