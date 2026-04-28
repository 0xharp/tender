use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("4RSbGBZQ7CDSv78DG3VoMcaKXBsoYvh9ZofEo6mTCvfQ");

#[program]
pub mod tender {
    use super::*;

    pub fn rfp_create(ctx: Context<RfpCreate>, args: RfpCreateArgs) -> Result<()> {
        instructions::rfp_create::handler(ctx, args)
    }

    pub fn rfp_close_bidding(ctx: Context<RfpCloseBidding>) -> Result<()> {
        instructions::rfp_close_bidding::handler(ctx)
    }

    pub fn commit_bid(ctx: Context<CommitBid>, args: CommitBidArgs) -> Result<()> {
        instructions::commit_bid::handler(ctx, args)
    }

    pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> {
        instructions::withdraw_bid::handler(ctx)
    }

    pub fn select_bid(ctx: Context<SelectBid>) -> Result<()> {
        instructions::select_bid::handler(ctx)
    }
}
