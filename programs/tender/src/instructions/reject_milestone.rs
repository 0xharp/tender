use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, MilestoneRejected, MilestoneState,
    MILESTONE_SEED, MilestoneStatus, ProviderReputation, PROVIDER_REP_SEED,
    ProviderReputationUpdated, Rfp, RfpStatus, SPLIT_NOT_PROPOSED,
};

/// Buyer escalates a submitted milestone to Dispute. Funds freeze for
/// `rfp.dispute_cooloff_secs`. Both parties may call `resolve_dispute` with a
/// matching split during the window; if no agreement, `dispute_default_split`
/// applies a 50/50 default after expiry.
///
/// Both parties take a reputation hit on rejection (whether the dispute
/// resolves favorably or not).
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct RejectMilestone<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Box<Account<'info, Rfp>>,

    #[account(
        mut,
        seeds = [MILESTONE_SEED, rfp.key().as_ref(), &[milestone_index]],
        bump = milestone.bump,
        constraint = milestone.rfp == rfp.key() @ TenderError::InvalidRfpStatus,
        constraint = milestone.index == milestone_index @ TenderError::InvalidMilestoneIndex,
    )]
    pub milestone: Account<'info, MilestoneState>,

    #[account(
        mut,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Account<'info, ProviderReputation>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RejectMilestone>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Submitted, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= ms.review_deadline, TenderError::ReviewWindowExpired);

    ms.status = MilestoneStatus::Disputed;
    ms.disputed_at = now;
    ms.dispute_deadline = now + rfp.dispute_cooloff_secs;
    ms.buyer_proposed_split_bps = SPLIT_NOT_PROPOSED;
    ms.provider_proposed_split_bps = SPLIT_NOT_PROPOSED;

    rfp.status = RfpStatus::Disputed;

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    buyer_rep.disputed_milestones = buyer_rep.disputed_milestones.saturating_add(1);
    buyer_rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 4, at: now });

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.disputed_milestones = provider_rep.disputed_milestones.saturating_add(1);
    provider_rep.last_updated = now;
    emit!(ProviderReputationUpdated { provider: provider_rep.provider, field: 2, at: now });

    emit!(MilestoneRejected {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        dispute_deadline: ms.dispute_deadline,
    });
    Ok(())
}
