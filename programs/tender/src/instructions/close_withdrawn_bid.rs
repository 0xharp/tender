use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::ClosePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::errors::TenderError;
use crate::state::{BidClosed, BidCommit, BidStatus, Rfp};

/// Phase 2 of withdrawal - base-layer follow-up after `withdraw_bid` undelegate.
/// Closes the BidCommit + the permission account, refunds rent to the bid signer.
#[derive(Accounts)]
pub struct CloseWithdrawnBid<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(
        mut,
        constraint = rfp.key() == bid.rfp @ TenderError::InvalidRfpStatus,
    )]
    pub rfp: Account<'info, Rfp>,

    #[account(
        mut,
        close = provider,
        constraint = bid.status == BidStatus::Withdrawn @ TenderError::InvalidBidStatus,
    )]
    pub bid: Account<'info, BidCommit>,

    /// CHECK: Permission account (post-undelegate, owned by permission program).
    #[account(
        mut,
        seeds = [PERMISSION_SEED, bid.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: AccountInfo<'info>,

    /// CHECK: Permission program (address-checked).
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CloseWithdrawnBid>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.provider.key(),
        ctx.accounts.bid.provider,
        TenderError::NotProvider
    );

    ClosePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .payer(&ctx.accounts.provider.to_account_info())
        .authority(&ctx.accounts.provider.to_account_info(), true)
        .permissioned_account(&ctx.accounts.bid.to_account_info(), false)
        .permission(&ctx.accounts.permission.to_account_info())
        .invoke()?;

    let rfp = &mut ctx.accounts.rfp;
    rfp.bid_count = rfp.bid_count.saturating_sub(1);

    let now = Clock::get()?.unix_timestamp;
    emit!(BidClosed {
        bid: ctx.accounts.bid.key(),
        rfp: rfp.key(),
        provider: ctx.accounts.provider.key(),
        closed_at: now,
    });

    Ok(())
}
