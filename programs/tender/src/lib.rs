use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("4RSbGBZQ7CDSv78DG3VoMcaKXBsoYvh9ZofEo6mTCvfQ");

#[ephemeral]
#[program]
pub mod tender {
    use super::*;

    /* ----- Base layer: RFP lifecycle --------------------------------------- */

    pub fn rfp_create(ctx: Context<RfpCreate>, args: RfpCreateArgs) -> Result<()> {
        instructions::rfp_create::handler(ctx, args)
    }

    pub fn rfp_close_bidding(ctx: Context<RfpCloseBidding>) -> Result<()> {
        instructions::rfp_close_bidding::handler(ctx)
    }

    /* ----- Base layer: bid submit phase 1 + delegation to PER -------------- */

    pub fn commit_bid_init(
        ctx: Context<CommitBidInit>,
        args: CommitBidInitArgs,
    ) -> Result<()> {
        instructions::commit_bid_init::handler(ctx, args)
    }

    pub fn delegate_bid(ctx: Context<DelegateBid>, args: DelegateBidArgs) -> Result<()> {
        instructions::delegate_bid::handler(ctx, args)
    }

    /* ----- ER: chunked envelope writes + finalize -------------------------- */

    pub fn write_bid_chunk(
        ctx: Context<WriteBidChunk>,
        args: WriteBidChunkArgs,
    ) -> Result<()> {
        instructions::write_bid_chunk::handler(ctx, args)
    }

    pub fn finalize_bid(ctx: Context<FinalizeBid>) -> Result<()> {
        instructions::finalize_bid::handler(ctx)
    }

    /* ----- ER: time-gated reveal + buyer selection ------------------------- */

    pub fn open_reveal_window(
        ctx: Context<OpenRevealWindow>,
        args: OpenRevealWindowArgs,
    ) -> Result<()> {
        instructions::open_reveal_window::handler(ctx, args)
    }

    pub fn select_bid(ctx: Context<SelectBid>, args: SelectBidArgs) -> Result<()> {
        instructions::select_bid::handler(ctx, args)
    }

    /* ----- Provider withdrawal (two-tx flow) ------------------------------ */

    /// Tx 1 (ER): commit + undelegate the bid; flips status to Withdrawn.
    pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> {
        instructions::withdraw_bid::handler(ctx)
    }

    /// Tx 2 (base layer): close the bid + decrement rfp.bid_count.
    /// Must run after `withdraw_bid`'s seal-back lands on base layer.
    pub fn close_withdrawn_bid(ctx: Context<CloseWithdrawnBid>) -> Result<()> {
        instructions::close_withdrawn_bid::handler(ctx)
    }

    /* ----- Magic Action targets (base layer, invoked by post-commit actions) */

    pub fn select_bid_finalize(
        ctx: Context<SelectBidFinalize>,
        provider_wallet: Pubkey,
    ) -> Result<()> {
        instructions::select_bid::select_bid_finalize_handler(ctx, provider_wallet)
    }
}
