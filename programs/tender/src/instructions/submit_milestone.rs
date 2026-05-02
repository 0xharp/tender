use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    MilestoneState, MILESTONE_SEED, MilestoneStatus, MilestoneSubmitted, Rfp, RfpStatus,
};

/// Provider attests milestone work is done. Sets `submitted_at` + `review_deadline`.
/// Buyer now has `rfp.review_window_secs` to ACCEPT, REQUEST_CHANGES, or REJECT.
/// If they do nothing past the deadline, the milestone auto-releases via
/// `auto_release_milestone` (permissionless).
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
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

pub fn handler(ctx: Context<SubmitMilestone>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Funded | RfpStatus::InProgress),
        TenderError::InvalidRfpStatus
    );
    require!(
        rfp.winner_provider == Some(ctx.accounts.provider.key()),
        TenderError::NotProvider
    );

    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Started, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    ms.status = MilestoneStatus::Submitted;
    ms.submitted_at = now;
    ms.review_deadline = now + rfp.review_window_secs;

    if rfp.status == RfpStatus::Funded {
        rfp.status = RfpStatus::InProgress;
    }

    emit!(MilestoneSubmitted {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        review_deadline: ms.review_deadline,
        iteration: ms.iteration_count,
    });
    Ok(())
}
