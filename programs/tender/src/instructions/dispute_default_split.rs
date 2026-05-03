use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, DisputeResolved, Escrow, ESCROW_SEED,
    MilestoneState, MILESTONE_SEED, MilestoneStatus, NO_ACTIVE_MILESTONE, ProviderReputation,
    PROVIDER_REP_SEED, ProviderReputationUpdated, Rfp, RfpCompleted, RfpStatus, Treasury,
    TREASURY_SEED, BPS_DENOMINATOR,
};

/// Permissionless after `dispute_deadline` expires with no resolve_dispute
/// agreement. Applies a 50/50 default split. Deliberately unsatisfying - its
/// purpose is to PUSH parties to settle off-platform via resolve_dispute.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct DisputeDefaultSplit<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub rfp: Box<Account<'info, Rfp>>,

    #[account(
        mut,
        seeds = [MILESTONE_SEED, rfp.key().as_ref(), &[milestone_index]],
        bump = milestone.bump,
    )]
    pub milestone: Account<'info, MilestoneState>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump = escrow.bump,
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
        constraint = buyer_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = buyer_ata.owner == rfp.buyer @ TenderError::NotBuyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    /// Buyer + provider reputation - need updating because before this fix the
    /// default-split path was the only settlement that left rep stats stale
    /// (`reject_milestone` already incremented `disputed_milestones` on both
    /// sides; the AMOUNTS only landed when `resolve_dispute` was called).
    /// init_if_needed because the permissionless caller pays for any rent if
    /// somehow the accounts are missing - in practice both exist by this
    /// stage of the lifecycle.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, rfp.buyer.as_ref()],
        bump,
    )]
    pub buyer_reputation: Box<Account<'info, BuyerReputation>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Box<Account<'info, ProviderReputation>>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DisputeDefaultSplit>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Disputed, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now > ms.dispute_deadline, TenderError::DisputeCooloffActive);

    // 50/50.
    let amount = ms.amount;
    let split_to_provider = amount / 2;
    let to_buyer_refund = amount.saturating_sub(split_to_provider);
    let fee = (split_to_provider as u128 * rfp.fee_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let to_provider_net = split_to_provider.saturating_sub(fee);

    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    if to_provider_net > 0 {
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
            to_provider_net,
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
    if to_buyer_refund > 0 {
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
            to_buyer_refund,
            ctx.accounts.mint.decimals,
        )?;
    }

    ms.status = MilestoneStatus::DisputeDefault;
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_released = escrow.total_released.saturating_add(split_to_provider);
    escrow.total_refunded = escrow.total_refunded.saturating_add(to_buyer_refund);

    let treasury = &mut ctx.accounts.treasury;
    treasury.total_collected = treasury.total_collected.saturating_add(fee);

    // Reputation updates - mirror resolve_dispute. Counter increments
    // (disputed_milestones) ALREADY happened at reject_milestone time;
    // here we add the AMOUNT side so default-resolve doesn't leak stats.
    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = rfp.buyer;
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    buyer_rep.total_released_usdc = buyer_rep.total_released_usdc.saturating_add(split_to_provider);
    buyer_rep.total_refunded_usdc = buyer_rep.total_refunded_usdc.saturating_add(to_buyer_refund);
    buyer_rep.last_updated = now;

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_earned_usdc = provider_rep.total_earned_usdc.saturating_add(to_provider_net);
    provider_rep.last_updated = now;

    // dispute_default_split is hardcoded 50/50, so 50% always lands as
    // released - this site practically always reaches the Completed branch.
    // Cancelled fallback is defensive (matches cancel_with_notice's pattern).
    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        if escrow.total_released == 0 {
            rfp.status = RfpStatus::Cancelled;
        } else {
            rfp.status = RfpStatus::Completed;
            // On full project settlement, tick completion counters - same as
            // accept_milestone. Disputes that close the project still count as
            // completed RFPs from a "the escrow drained" perspective.
            provider_rep.completed_projects = provider_rep.completed_projects.saturating_add(1);
            buyer_rep.completed_rfps = buyer_rep.completed_rfps.saturating_add(1);
            emit!(ProviderReputationUpdated { provider: provider_rep.provider, field: 1, at: now });
            emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 2, at: now });
            emit!(RfpCompleted { rfp: rfp.key(), at: now });
        }
    } else {
        rfp.status = RfpStatus::InProgress;
    }

    emit!(DisputeResolved {
        rfp: rfp.key(),
        index: ms.index,
        split_to_provider_bps: 5_000,
        provider_amount: to_provider_net,
        buyer_refund: to_buyer_refund,
        fee_to_treasury: fee,
        at: now,
        default_applied: true,
    });
    Ok(())
}
