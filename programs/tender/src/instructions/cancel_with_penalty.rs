use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    ABANDON_PENALTY_BPS, BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Escrow,
    ESCROW_SEED, MilestoneCancelled, MilestoneState, MILESTONE_SEED, MilestoneStatus,
    NO_ACTIVE_MILESTONE, ProviderReputation, PROVIDER_REP_SEED, Rfp, RfpStatus, BPS_DENOMINATOR,
};

/// Buyer abandons a Started or Submitted milestone. 50% penalty (configurable)
/// goes to provider, 50% refunded to buyer. Status -> CancelledByBuyer.
///
/// Provider takes the penalty as compensation for ramp-down + context switch.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct CancelWithPenalty<'info> {
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

    pub mint: Box<Account<'info, Mint>>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = buyer_ata.owner == buyer.key() @ TenderError::NotBuyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = provider_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = provider_ata.owner == rfp.winner_provider.unwrap_or(Pubkey::default()) @ TenderError::NotProvider,
    )]
    pub provider_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    /// Provider rep - receives the penalty as `total_earned_usdc`.
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Account<'info, ProviderReputation>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelWithPenalty>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(
        matches!(ms.status, MilestoneStatus::Started | MilestoneStatus::Submitted),
        TenderError::InvalidMilestoneStatus
    );

    let amount = ms.amount;
    let penalty = (amount as u128 * ABANDON_PENALTY_BPS as u128 / BPS_DENOMINATOR as u128) as u64;
    let refund = amount.saturating_sub(penalty);
    let now = Clock::get()?.unix_timestamp;
    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    if penalty > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.provider_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            penalty,
            ctx.accounts.mint.decimals,
        )?;
    }
    if refund > 0 {
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
            refund,
            ctx.accounts.mint.decimals,
        )?;
    }

    ms.status = MilestoneStatus::CancelledByBuyer;
    // Free the active-milestone slot.
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_released = escrow.total_released.saturating_add(penalty);
    escrow.total_refunded = escrow.total_refunded.saturating_add(refund);

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    buyer_rep.cancelled_milestones = buyer_rep.cancelled_milestones.saturating_add(1);
    buyer_rep.total_released_usdc = buyer_rep.total_released_usdc.saturating_add(penalty);
    buyer_rep.total_refunded_usdc = buyer_rep.total_refunded_usdc.saturating_add(refund);
    buyer_rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 5, at: now });

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_earned_usdc = provider_rep.total_earned_usdc.saturating_add(penalty);
    provider_rep.last_updated = now;
    // No counter event - counter not bumped (penalty payout is a value
    // accounting change, not a "win" or "completion").

    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        rfp.status = RfpStatus::Completed;
    } else {
        rfp.status = RfpStatus::InProgress;
    }

    emit!(MilestoneCancelled {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        refund_to_buyer: refund,
        penalty_to_provider: penalty,
        kind: 1,
    });
    Ok(())
}
