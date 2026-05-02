use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    DisputeResolved, Escrow, ESCROW_SEED, MilestoneState, MILESTONE_SEED, MilestoneStatus,
    NO_ACTIVE_MILESTONE, Rfp, RfpStatus, Treasury, TREASURY_SEED, BPS_DENOMINATOR,
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

    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        rfp.status = RfpStatus::Completed;
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
