use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, Escrow, ESCROW_SEED, MilestoneCancelled, MilestoneState,
    MILESTONE_SEED, MilestoneStatus, Rfp, RfpStatus,
};

// cancel_with_notice = pre-start cancellation. Provider hasn't ramped up,
// no work lost. We refund the milestone amount fully and DON'T ding buyer
// reputation - that would conflate inventory rebalancing with bad actors.
// Only `cancel_with_penalty` (Started/Submitted) increments the rep counter.

/// Buyer cancels an unstarted milestone. Full refund of milestone amount back
/// to buyer (no penalty). Must be Pending status - once provider has Started
/// the milestone, this ix rejects and buyer must use `cancel_with_penalty`.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct CancelWithNotice<'info> {
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
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub mint: Account<'info, Mint>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub escrow_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = buyer_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = buyer_ata.owner == buyer.key() @ TenderError::NotBuyer,
    )]
    pub buyer_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelWithNotice>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Pending, TenderError::InvalidMilestoneStatus);

    let amount = ms.amount;
    let now = Clock::get()?.unix_timestamp;
    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    if amount > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
    }

    ms.status = MilestoneStatus::CancelledByBuyer;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_refunded = escrow.total_refunded.saturating_add(amount);

    // No-op on the buyer rep COUNTERS (cancelled_milestones), but bump the
    // amount tracker so total_refunded_usdc reflects what was pulled back.
    // No `BuyerReputationUpdated` event since no counter changed.
    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    buyer_rep.total_refunded_usdc = buyer_rep.total_refunded_usdc.saturating_add(amount);
    buyer_rep.last_updated = now;

    // Project-level auto-flip. If nothing was ever released to the provider
    // (every milestone resulted in a refund), distinguish from the
    // value-delivered case by setting Cancelled instead of Completed. Buyers
    // who serially cancel before any work shouldn't appear as having
    // "completed projects" in their on-chain reputation.
    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        rfp.status = if escrow.total_released == 0 {
            RfpStatus::Cancelled
        } else {
            RfpStatus::Completed
        };
    }

    emit!(MilestoneCancelled {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        refund_to_buyer: amount,
        penalty_to_provider: 0,
        kind: 0,
    });
    Ok(())
}
