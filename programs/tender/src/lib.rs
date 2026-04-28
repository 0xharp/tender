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

    pub fn bid_commit(ctx: Context<BidCommitIx>, args: BidCommitArgs) -> Result<()> {
        instructions::bid_commit::handler(ctx, args)
    }

    pub fn bid_withdraw(ctx: Context<BidWithdrawIx>) -> Result<()> {
        instructions::bid_withdraw::handler(ctx)
    }
}
