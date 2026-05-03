use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Escrow, ESCROW_SEED,
    MilestoneAccepted, MilestoneState, MILESTONE_SEED, MilestoneStatus, NO_ACTIVE_MILESTONE,
    ProviderReputation, PROVIDER_REP_SEED, ProviderReputationUpdated, Rfp, RfpCompleted, RfpStatus,
    Treasury, TREASURY_SEED, BPS_DENOMINATOR,
};

/// Permissionless after milestone.review_deadline expires. Releases the
/// milestone funds as if buyer had accepted (silence = consent).
///
/// Anyone can call. Same fund-flow as accept_milestone.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct AutoReleaseMilestone<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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

    #[account(
        mut,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.rfp == rfp.key() @ TenderError::InvalidRfpStatus,
    )]
    pub escrow: Account<'info, Escrow>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = provider_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = provider_ata.owner == rfp.winner_provider.unwrap_or(Pubkey::default()) @ TenderError::NotProvider,
    )]
    pub provider_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump = treasury.bump,
    )]
    pub treasury: Account<'info, Treasury>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Box<Account<'info, ProviderReputation>>,

    /// Buyer reputation - mirrors `accept_milestone` so silence-as-consent
    /// settlement still ticks the buyer's `total_released_usdc` and (on
    /// completion) `completed_rfps`. `init_if_needed` because in theory the
    /// account could be missing if `select_bid` was somehow skipped, though
    /// the lifecycle guarantees that doesn't happen. Permissionless caller
    /// (`payer`) covers any rent.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, rfp.buyer.as_ref()],
        bump,
    )]
    pub buyer_reputation: Box<Account<'info, BuyerReputation>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AutoReleaseMilestone>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Funded | RfpStatus::InProgress),
        TenderError::InvalidRfpStatus
    );

    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Submitted, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now > ms.review_deadline, TenderError::ReviewWindowOpen);

    let total = ms.amount;
    let fee = (total as u128 * rfp.fee_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let to_provider = total.checked_sub(fee).ok_or(TenderError::MathOverflow)?;

    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    if to_provider > 0 {
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
            to_provider,
            ctx.accounts.mint.decimals,
        )?;
    }

    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.treasury_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            fee,
            ctx.accounts.mint.decimals,
        )?;
    }

    ms.status = MilestoneStatus::Released;
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_released = escrow.total_released.saturating_add(total);

    let treasury = &mut ctx.accounts.treasury;
    treasury.total_collected = treasury.total_collected.saturating_add(fee);

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_earned_usdc = provider_rep.total_earned_usdc.saturating_add(to_provider);
    provider_rep.last_updated = now;

    // Buyer rep mirror - same fields accept_milestone touches. Auto-release
    // is functionally a buyer-accept-by-silence; the buyer's stats should
    // reflect that money left their escrow regardless of the trigger.
    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = rfp.buyer;
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    buyer_rep.total_released_usdc = buyer_rep.total_released_usdc.saturating_add(total);
    buyer_rep.last_updated = now;

    emit!(MilestoneAccepted {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        auto_released: true,
        amount_to_provider: to_provider,
        fee_to_treasury: fee,
    });

    // total_wins counted at award time. Only completed_projects ticks here.
    // auto_release always adds to total_released, so this site can only reach
    // the Completed branch in practice - the Cancelled fallback is defensive.
    let total_settled = escrow.total_released.saturating_add(escrow.total_refunded);
    if total_settled >= escrow.total_locked {
        if escrow.total_released == 0 {
            rfp.status = RfpStatus::Cancelled;
        } else {
            rfp.status = RfpStatus::Completed;
            provider_rep.completed_projects = provider_rep.completed_projects.saturating_add(1);
            buyer_rep.completed_rfps = buyer_rep.completed_rfps.saturating_add(1);
            emit!(ProviderReputationUpdated { provider: provider_rep.provider, field: 1, at: now });
            emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 2, at: now });
            emit!(RfpCompleted { rfp: rfp.key(), at: now });
        }
    }

    Ok(())
}
