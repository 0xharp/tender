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

    /* ----- Treasury init (one-time) ---------------------------------------- */
    pub fn init_treasury(ctx: Context<InitTreasury>, authority: Pubkey) -> Result<()> {
        instructions::init_treasury::handler(ctx, authority)
    }

    /* ----- Base layer: RFP lifecycle --------------------------------------- */
    pub fn rfp_create(ctx: Context<RfpCreate>, args: RfpCreateArgs) -> Result<()> {
        instructions::rfp_create::handler(ctx, args)
    }
    pub fn rfp_close_bidding(ctx: Context<RfpCloseBidding>) -> Result<()> {
        instructions::rfp_close_bidding::handler(ctx)
    }
    pub fn reveal_reserve(ctx: Context<RevealReserve>, args: RevealReserveArgs) -> Result<()> {
        instructions::reveal_reserve::handler(ctx, args)
    }

    /* ----- Base layer: bid submit phase 1 + delegation to PER -------------- */
    pub fn commit_bid_init(ctx: Context<CommitBidInit>, args: CommitBidInitArgs) -> Result<()> {
        instructions::commit_bid_init::handler(ctx, args)
    }
    pub fn delegate_bid(ctx: Context<DelegateBid>) -> Result<()> {
        instructions::delegate_bid::handler(ctx)
    }

    /* ----- ER: chunked envelope writes + finalize -------------------------- */
    pub fn write_bid_chunk(ctx: Context<WriteBidChunk>, args: WriteBidChunkArgs) -> Result<()> {
        instructions::write_bid_chunk::handler(ctx, args)
    }
    pub fn finalize_bid(ctx: Context<FinalizeBid>) -> Result<()> {
        instructions::finalize_bid::handler(ctx)
    }

    /* ----- ER: time-gated reveal ------------------------------------------- */
    pub fn open_reveal_window(ctx: Context<OpenRevealWindow>) -> Result<()> {
        instructions::open_reveal_window::handler(ctx)
    }

    /* ----- Base layer: select winner + project funding -------------------- */
    pub fn select_bid(ctx: Context<SelectBid>, args: SelectBidArgs) -> Result<()> {
        instructions::select_bid::handler(ctx, args)
    }
    pub fn fund_project<'info>(ctx: Context<'_, '_, '_, 'info, FundProject<'info>>) -> Result<()> {
        instructions::fund_project::handler(ctx)
    }

    /* ----- Provider withdrawal (two-tx flow, Day 6.5) ---------------------- */
    pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> {
        instructions::withdraw_bid::handler(ctx)
    }
    pub fn close_withdrawn_bid(ctx: Context<CloseWithdrawnBid>) -> Result<()> {
        instructions::close_withdrawn_bid::handler(ctx)
    }

    /* ----- Milestone lifecycle -------------------------------------------- */
    pub fn start_milestone(ctx: Context<StartMilestone>, milestone_index: u8) -> Result<()> {
        instructions::start_milestone::handler(ctx, milestone_index)
    }
    pub fn submit_milestone(ctx: Context<SubmitMilestone>, milestone_index: u8) -> Result<()> {
        instructions::submit_milestone::handler(ctx, milestone_index)
    }
    pub fn accept_milestone(ctx: Context<AcceptMilestone>, milestone_index: u8) -> Result<()> {
        instructions::accept_milestone::handler(ctx, milestone_index)
    }
    pub fn auto_release_milestone(
        ctx: Context<AutoReleaseMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::auto_release_milestone::handler(ctx, milestone_index)
    }
    pub fn request_changes(ctx: Context<RequestChanges>, milestone_index: u8) -> Result<()> {
        instructions::request_changes::handler(ctx, milestone_index)
    }
    pub fn reject_milestone(ctx: Context<RejectMilestone>, milestone_index: u8) -> Result<()> {
        instructions::reject_milestone::handler(ctx, milestone_index)
    }

    /* ----- Cancel paths --------------------------------------------------- */
    pub fn cancel_with_notice(ctx: Context<CancelWithNotice>, milestone_index: u8) -> Result<()> {
        instructions::cancel_with_notice::handler(ctx, milestone_index)
    }
    pub fn cancel_with_penalty(
        ctx: Context<CancelWithPenalty>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::cancel_with_penalty::handler(ctx, milestone_index)
    }
    pub fn cancel_late_milestone(
        ctx: Context<CancelLateMilestone>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::cancel_late_milestone::handler(ctx, milestone_index)
    }
    pub fn mark_buyer_ghosted(ctx: Context<MarkBuyerGhosted>) -> Result<()> {
        instructions::mark_buyer_ghosted::handler(ctx)
    }
    pub fn expire_rfp(ctx: Context<ExpireRfp>) -> Result<()> {
        instructions::expire_rfp::handler(ctx)
    }

    /* ----- Dispute resolution --------------------------------------------- */
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        milestone_index: u8,
        args: ResolveDisputeArgs,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, milestone_index, args)
    }
    pub fn dispute_default_split(
        ctx: Context<DisputeDefaultSplit>,
        milestone_index: u8,
    ) -> Result<()> {
        instructions::dispute_default_split::handler(ctx, milestone_index)
    }

}
