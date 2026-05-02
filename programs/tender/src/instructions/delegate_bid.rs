use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder, DelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::state::Rfp;

mod flags {
    pub const AUTHORITY: u8 = 1 << 0;
    pub const TX_LOGS: u8 = 1 << 1;
    pub const TX_BALANCES: u8 = 1 << 2;
    pub const TX_MESSAGE: u8 = 1 << 3;
    pub const ACCOUNT_SIGNATURES: u8 = 1 << 4;
    pub const READ_ONLY: u8 = TX_LOGS | TX_BALANCES | TX_MESSAGE | ACCOUNT_SIGNATURES;
    pub const PROVIDER: u8 = AUTHORITY | READ_ONLY;
}

pub use flags::READ_ONLY as PER_FLAGS_READ_ONLY;
pub use flags::PROVIDER as PER_FLAGS_PROVIDER;

/// Phase 2 of bid submission. Bid PDA = `["bid", rfp, provider]` - derived from
/// the signer's pubkey directly, no separate seed.
#[delegate]
#[derive(Accounts)]
pub struct DelegateBid<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    pub rfp: Account<'info, Rfp>,

    /// CHECK: The bid PDA, will be delegated to PER.
    #[account(
        mut,
        del,
        seeds = [b"bid", rfp.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub bid: AccountInfo<'info>,

    /// CHECK: Permission account for the bid PDA.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, bid.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: AccountInfo<'info>,

    /// CHECK: Buffer for the permission delegation handshake.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATE_BUFFER_TAG, permission.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID
    )]
    pub buffer_permission: AccountInfo<'info>,

    /// CHECK: Delegation record for the permission account.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_RECORD_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub delegation_record_permission: AccountInfo<'info>,

    /// CHECK: Delegation metadata for the permission account.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_METADATA_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id()
    )]
    pub delegation_metadata_permission: AccountInfo<'info>,

    /// CHECK: Permission program (address-checked).
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: Optional specific validator (TEE-capable for PER).
    pub validator: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<DelegateBid>) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref();
    let rfp_key = ctx.accounts.rfp.to_account_info().key;
    let provider_key = ctx.accounts.provider.key();
    let bid_signer_seeds: &[&[u8]] = &[
        b"bid",
        rfp_key.as_ref(),
        provider_key.as_ref(),
        std::slice::from_ref(&ctx.bumps.bid),
    ];

    if ctx.accounts.permission.data_is_empty() {
        let provider_member = Member {
            flags: flags::PROVIDER,
            pubkey: ctx.accounts.provider.key(),
        };
        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&ctx.accounts.bid)
            .permission(&ctx.accounts.permission)
            .payer(&ctx.accounts.provider.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .args(MembersArgs { members: Some(vec![provider_member]) })
            .invoke_signed(&[bid_signer_seeds])?;
    }

    if ctx.accounts.permission.owner != &ephemeral_rollups_sdk::id() {
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .permissioned_account(&ctx.accounts.bid, true)
            .permission(&ctx.accounts.permission.to_account_info())
            .payer(&ctx.accounts.provider.to_account_info())
            .authority(&ctx.accounts.bid, false)
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.buffer_permission.to_account_info())
            .delegation_metadata(&ctx.accounts.delegation_metadata_permission.to_account_info())
            .delegation_record(&ctx.accounts.delegation_record_permission.to_account_info())
            .delegation_program(&ctx.accounts.delegation_program.to_account_info())
            .validator(validator)
            .invoke_signed(&[bid_signer_seeds])?;
    }

    if ctx.accounts.bid.owner != &ephemeral_rollups_sdk::id() {
        ctx.accounts.delegate_bid(
            &ctx.accounts.provider,
            &[b"bid", rfp_key.as_ref(), provider_key.as_ref()],
            DelegateConfig {
                validator: validator.map(|v| v.key()),
                ..Default::default()
            },
        )?;
    }

    Ok(())
}
