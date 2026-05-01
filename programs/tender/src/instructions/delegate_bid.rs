use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder, DelegatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::state::Rfp;

/// MagicBlock PER member flag bits. Mirror of the constants in
/// `ephemeral-rollups-sdk::access_control::structs::member` — duplicated here so
/// our intent is auditable from the program source.
mod flags {
    pub const AUTHORITY: u8 = 1 << 0;
    pub const TX_LOGS: u8 = 1 << 1;
    pub const TX_BALANCES: u8 = 1 << 2;
    pub const TX_MESSAGE: u8 = 1 << 3;
    pub const ACCOUNT_SIGNATURES: u8 = 1 << 4;

    /// Read-only visibility set: granted to the buyer once `open_reveal_window`
    /// fires after `bid_close_at`. No `AUTHORITY` — buyer cannot change membership
    /// or perform privileged operations on the bid.
    pub const READ_ONLY: u8 = TX_LOGS | TX_BALANCES | TX_MESSAGE | ACCOUNT_SIGNATURES;

    /// Full-control set: granted to the provider on `delegate_bid`. They can
    /// read, write chunks, finalize, and ultimately undelegate (via `withdraw_bid`
    /// or as part of a `select_bid` flow).
    pub const PROVIDER: u8 = AUTHORITY | READ_ONLY;
}

pub use flags::READ_ONLY as PER_FLAGS_READ_ONLY;
pub use flags::PROVIDER as PER_FLAGS_PROVIDER;

/// Phase 2 of bid submission (base layer, same tx as `commit_bid_init`).
///
/// 1. Creates the permission account with the provider as the only initial
///    member (with full flags).
/// 2. Delegates the permission account itself to PER so subsequent member
///    updates (notably `open_reveal_window`) execute on the ER.
/// 3. Delegates the bid account to PER under the TEE-backed validator.
///
/// After this, the `BidCommit` account is owned by the delegation program; all
/// subsequent reads/writes go through the ER RPC.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DelegateBidArgs {
    pub bid_pda_seed: [u8; 32],
}

#[delegate]
#[derive(Accounts)]
#[instruction(args: DelegateBidArgs)]
pub struct DelegateBid<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    pub rfp: Account<'info, Rfp>,

    /// CHECK: The bid PDA, will be delegated to PER.
    #[account(
        mut,
        del,
        seeds = [b"bid", rfp.key().as_ref(), args.bid_pda_seed.as_ref()],
        bump,
    )]
    pub bid: AccountInfo<'info>,

    /// CHECK: Permission account for the bid PDA. Initialized via CPI on first delegate.
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

    /// CHECK: Optional specific validator. For PER, pass the TEE-capable
    /// validator pubkey (e.g. `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` on
    /// devnet). When `None`, MagicBlock picks a default — fine for ER but may
    /// not satisfy PER's TEE requirement, so the client should always provide it.
    pub validator: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<DelegateBid>, args: DelegateBidArgs) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref();
    let bid_signer_seeds: &[&[u8]] = &[
        b"bid",
        ctx.accounts.rfp.to_account_info().key.as_ref(),
        args.bid_pda_seed.as_ref(),
        std::slice::from_ref(&ctx.bumps.bid),
    ];

    // 1. Create permission account with provider as the only initial member.
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
            .args(MembersArgs {
                members: Some(vec![provider_member]),
            })
            .invoke_signed(&[bid_signer_seeds])?;
    }

    // 2. Delegate the permission account to PER so member updates run on the ER.
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

    // 3. Delegate the bid account itself.
    if ctx.accounts.bid.owner != &ephemeral_rollups_sdk::id() {
        ctx.accounts.delegate_bid(
            &ctx.accounts.provider,
            &[
                b"bid",
                ctx.accounts.rfp.to_account_info().key.as_ref(),
                args.bid_pda_seed.as_ref(),
            ],
            DelegateConfig {
                validator: validator.map(|v| v.key()),
                ..Default::default()
            },
        )?;
    }

    Ok(())
}
