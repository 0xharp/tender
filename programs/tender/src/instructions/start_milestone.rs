use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    MAX_MILESTONE_COUNT, MilestoneStarted, MilestoneState, MILESTONE_SEED, MilestoneStatus,
    NO_ACTIVE_MILESTONE, Rfp, RfpStatus,
};

/// Provider commits to working on milestone N. After this ix, the milestone is
/// `Started` and `cancel_with_penalty` applies (50% goes to provider if buyer
/// abandons).
///
/// Provider's wallet must match `rfp.winner_provider`. (For ephemeral modes,
/// the ephemeral wallet IS the winner_provider.)
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct StartMilestone<'info> {
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

#[qedgen_macros::qed(verified, spec = "../../tender.qedspec", handler = "start_milestone", hash = "3e023cf51019e49f", spec_hash = "eec9b1a8ac1f66fd", accounts = "StartMilestone", accounts_file = "src/instructions/start_milestone.rs", accounts_hash = "68b838642de51219")]
pub fn handler(ctx: Context<StartMilestone>, milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Funded | RfpStatus::InProgress),
        TenderError::InvalidRfpStatus
    );
    require!(
        rfp.winner_provider == Some(ctx.accounts.provider.key()),
        TenderError::NotProvider
    );
    // Bound milestone_index explicitly to the array slot range. The Anchor
    // PDA seeds already make `index = 255` unreachable at runtime (no
    // milestone account exists there — they're only created 0..milestone_count
    // at fund_project), but stating the bound explicitly mirrors the qedspec
    // `requires milestone_index < MAX_MILESTONE_COUNT` so the spec ↔ code
    // correspondence is 1:1 without relying on Anchor's PDA validation.
    require!(milestone_index < MAX_MILESTONE_COUNT, TenderError::InvalidMilestoneIndex);
    // Single-milestone-in-flight: provider can only have ONE milestone active
    // at a time (Started OR Submitted). Prevents stuffing all milestones into
    // Started to lock funds without delivering.
    require!(
        rfp.active_milestone_index == NO_ACTIVE_MILESTONE,
        TenderError::AnotherMilestoneActive
    );

    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Pending, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    ms.status = MilestoneStatus::Started;
    ms.started_at = now;

    // Per-milestone delivery deadline. 0 duration in the bid = no deadline,
    // and we leave delivery_deadline at 0 (cancel_late_milestone unavailable).
    let duration = rfp.milestone_durations_secs[ms.index as usize];
    ms.delivery_deadline = if duration > 0 { now.saturating_add(duration) } else { 0 };

    rfp.active_milestone_index = ms.index;
    rfp.status = RfpStatus::InProgress;

    emit!(MilestoneStarted {
        rfp: rfp.key(),
        index: ms.index,
        provider: ctx.accounts.provider.key(),
        at: now,
    });
    Ok(())
}
