use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    MilestoneChangesRequested, MilestoneState, MILESTONE_SEED, MilestoneStatus, Rfp,
};

/// Buyer asks provider for changes on a submitted milestone. Increments
/// iteration_count + resets status back to Started (so provider can iterate
/// and re-submit). If iteration_count would exceed `rfp.max_iterations`, the
/// milestone auto-escalates to Disputed.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct RequestChanges<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
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
}

pub fn handler(ctx: Context<RequestChanges>, _milestone_index: u8) -> Result<()> {
    let rfp = &ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Submitted, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= ms.review_deadline, TenderError::ReviewWindowExpired);

    if ms.iteration_count >= rfp.max_iterations {
        // Auto-escalate to dispute.
        ms.status = MilestoneStatus::Disputed;
        ms.disputed_at = now;
        ms.dispute_deadline = now + rfp.dispute_cooloff_secs;
    } else {
        ms.iteration_count = ms.iteration_count.saturating_add(1);
        ms.status = MilestoneStatus::Started;
        ms.review_deadline = 0;
    }

    emit!(MilestoneChangesRequested {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        iteration: ms.iteration_count,
    });
    Ok(())
}
