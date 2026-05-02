use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, Escrow, ESCROW_SEED, MilestoneCancelled, MilestoneState,
    MILESTONE_SEED, MilestoneStatus, NO_ACTIVE_MILESTONE, ProviderReputation, PROVIDER_REP_SEED,
    ProviderReputationUpdated, Rfp, RfpStatus,
};

/// Buyer cancels a milestone whose `delivery_deadline` has passed without the
/// provider submitting. **Full refund to buyer, no penalty.** The provider's
/// reputation takes a `late_milestones += 1` hit because they committed to a
/// deadline and missed it.
///
/// Distinct from:
///   - `cancel_with_notice` - milestone was Pending (provider hadn't started)
///   - `cancel_with_penalty` - buyer's choice mid-flight; provider gets 50%
///   - this ix                - provider's fault (missed their own deadline)
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct CancelLateMilestone<'info> {
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
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    /// Provider rep - gets the late_milestones increment.
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

pub fn handler(ctx: Context<CancelLateMilestone>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;

    // Provider must have started this milestone (otherwise use cancel_with_notice).
    require!(ms.status == MilestoneStatus::Started, TenderError::InvalidMilestoneStatus);
    // Milestone must have a configured deadline (legacy bids without per-milestone
    // duration aren't eligible for this no-penalty path).
    require!(ms.delivery_deadline > 0, TenderError::NoDeliveryDeadline);

    let now = Clock::get()?.unix_timestamp;
    require!(now > ms.delivery_deadline, TenderError::DeliveryDeadlineNotPassed);

    let amount = ms.amount;
    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    // Full refund to buyer.
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
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_refunded = escrow.total_refunded.saturating_add(amount);

    // Buyer rep - amount tracker only (no counter ding; this is provider's fault).
    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = ctx.accounts.buyer.key();
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    buyer_rep.total_refunded_usdc = buyer_rep.total_refunded_usdc.saturating_add(amount);
    buyer_rep.last_updated = now;

    // Provider rep - late_milestones counter goes up. No total_earned change.
    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.late_milestones = provider_rep.late_milestones.saturating_add(1);
    provider_rep.last_updated = now;
    emit!(ProviderReputationUpdated { provider: provider_rep.provider, field: 4, at: now });
    // BuyerReputationUpdated event suppressed - buyer didn't accrue any
    // counter change (cancellation was provider's fault).

    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        rfp.status = RfpStatus::Completed;
    } else {
        rfp.status = RfpStatus::InProgress;
    }

    emit!(MilestoneCancelled {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        refund_to_buyer: amount,
        penalty_to_provider: 0,
        kind: 2,                  // 2 = cancel_late_milestone
    });
    Ok(())
}
