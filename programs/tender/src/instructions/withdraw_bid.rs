use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CommitAndUndelegatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::TenderError;
use crate::state::{BidCommit, BidStatus, BidWithdrawn};

/// Provider-initiated bid withdrawal - phase 1 of 2 (ER side).
///
/// Bid PDA is `["bid", rfp, provider]` - the same wallet that signed
/// `commit_bid_init` must sign withdraw. No identity-binding indirection.
#[commit]
#[derive(Accounts)]
pub struct WithdrawBid<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
    pub bid: Account<'info, BidCommit>,

    /// CHECK: Permission account, delegated to PER. Released by the CPI below.
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

pub fn handler(ctx: Context<WithdrawBid>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    let bid_rfp;
    let bid_provider;
    let bid_bump_arr: [u8; 1];
    {
        let bid = &ctx.accounts.bid;
        require!(
            matches!(bid.status, BidStatus::Initializing | BidStatus::Committed),
            TenderError::BidNotWithdrawable
        );
        require!(now < bid.bid_close_at, TenderError::BidWindowClosed);
        require_keys_eq!(ctx.accounts.provider.key(), bid.provider, TenderError::NotProvider);

        bid_rfp = bid.rfp;
        bid_provider = bid.provider;
        bid_bump_arr = [bid.bump];
    }
    let bid_signer_seeds: [&[u8]; 4] = [
        b"bid",
        bid_rfp.as_ref(),
        bid_provider.as_ref(),
        bid_bump_arr.as_ref(),
    ];

    {
        let bid = &mut ctx.accounts.bid;
        bid.status = BidStatus::Withdrawn;
    }
    ctx.accounts.bid.exit(&crate::ID)?;

    CommitAndUndelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .authority(&ctx.accounts.provider.to_account_info(), true)
        .permissioned_account(&ctx.accounts.bid.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .magic_context(&ctx.accounts.magic_context.to_account_info())
        .magic_program(&ctx.accounts.magic_program.to_account_info())
        .invoke_signed(&[&bid_signer_seeds])?;

    MagicIntentBundleBuilder::new(
        ctx.accounts.provider.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.bid.to_account_info()])
    .build_and_invoke()?;

    emit!(BidWithdrawn {
        bid: ctx.accounts.bid.key(),
        rfp: bid_rfp,
        withdrawn_at: now,
    });

    Ok(())
}
