use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    BidderVisibility, MAX_MILESTONE_COUNT, NO_ACTIVE_MILESTONE, PLATFORM_FEE_BPS, Rfp, RfpCreated,
    RfpStatus, BPS_DENOMINATOR,
    DEFAULT_CANCEL_NOTICE_SECS, DEFAULT_DISPUTE_COOLOFF_SECS, DEFAULT_FUNDING_WINDOW_SECS,
    DEFAULT_MAX_ITERATIONS, DEFAULT_REVIEW_WINDOW_SECS,
};

/// RFP create args.
///
/// Milestones (count + percentages) are deliberately NOT specified here - they
/// come from the winning bid's plaintext at award time, written via
/// `select_bid`. RFPs describe scope; bids describe how to deliver, including
/// payment cadence. This means a single RFP can attract proposals with very
/// different milestone structures (1 milestone all-or-nothing vs. 5 phased
/// milestones with iterative review) and the buyer picks based on the whole
/// proposal, not just price.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RfpCreateArgs {
    pub rfp_nonce: [u8; 8],
    pub buyer_encryption_pubkey: [u8; 32],
    pub title_hash: [u8; 32],
    pub category: u8,
    pub bid_open_at: i64,
    pub bid_close_at: i64,
    pub reveal_close_at: i64,
    pub bidder_visibility: BidderVisibility,

    /// SHA-256(reserve_amount_le_bytes || reserve_nonce). All zeros = no reserve.
    pub reserve_price_commitment: [u8; 32],

    /// Per-RFP windows. Pass 0 to use defaults.
    pub funding_window_secs: i64,
    pub review_window_secs: i64,
    pub dispute_cooloff_secs: i64,
    pub cancel_notice_secs: i64,
    pub max_iterations: u8,
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
    require!(
        args.bid_open_at < args.bid_close_at && args.bid_close_at < args.reveal_close_at,
        TenderError::InvalidBidWindow
    );

    let funding = if args.funding_window_secs > 0 { args.funding_window_secs } else { DEFAULT_FUNDING_WINDOW_SECS };
    let review = if args.review_window_secs > 0 { args.review_window_secs } else { DEFAULT_REVIEW_WINDOW_SECS };
    let dispute = if args.dispute_cooloff_secs > 0 { args.dispute_cooloff_secs } else { DEFAULT_DISPUTE_COOLOFF_SECS };
    let cancel = if args.cancel_notice_secs > 0 { args.cancel_notice_secs } else { DEFAULT_CANCEL_NOTICE_SECS };
    let max_iter = if args.max_iterations > 0 { args.max_iterations } else { DEFAULT_MAX_ITERATIONS };
    require!(funding > 0 && review > 0 && dispute > 0 && cancel > 0, TenderError::InvalidWindowSecs);
    require!(max_iter > 0, TenderError::InvalidMaxIterations);

    let now = Clock::get()?.unix_timestamp;
    let has_reserve = args.reserve_price_commitment != [0u8; 32];

    let rfp = &mut ctx.accounts.rfp;
    rfp.buyer = ctx.accounts.buyer.key();
    rfp.buyer_encryption_pubkey = args.buyer_encryption_pubkey;
    rfp.title_hash = args.title_hash;
    rfp.category = args.category;
    rfp.bid_open_at = args.bid_open_at;
    rfp.bid_close_at = args.bid_close_at;
    rfp.reveal_close_at = args.reveal_close_at;
    // Milestones populated at award time by `select_bid` from the winning bid.
    rfp.milestone_count = 0;
    rfp.milestone_amounts = [0u64; MAX_MILESTONE_COUNT as usize];
    rfp.milestone_durations_secs = [0i64; MAX_MILESTONE_COUNT as usize];
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    rfp.bidder_visibility = args.bidder_visibility;
    rfp.status = RfpStatus::Open;
    rfp.winner = None;
    rfp.winner_provider = None;
    rfp.contract_value = 0;
    rfp.bid_count = 0;
    rfp.created_at = now;
    rfp.bump = ctx.bumps.rfp;
    rfp.reserve_price_commitment = args.reserve_price_commitment;
    rfp.reserve_price_revealed = 0;
    rfp.funding_window_secs = funding;
    rfp.review_window_secs = review;
    rfp.dispute_cooloff_secs = dispute;
    rfp.cancel_notice_secs = cancel;
    rfp.max_iterations = max_iter;
    rfp.funding_deadline = 0;
    rfp.fee_bps = PLATFORM_FEE_BPS;
    require!(rfp.fee_bps as u32 <= BPS_DENOMINATOR as u32, TenderError::InvalidFeeBps);

    emit!(RfpCreated {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        category: rfp.category,
        bid_close_at: rfp.bid_close_at,
        reveal_close_at: rfp.reveal_close_at,
        milestone_count: 0,
        bidder_visibility: rfp.bidder_visibility,
        has_reserve,
    });

    Ok(())
}
