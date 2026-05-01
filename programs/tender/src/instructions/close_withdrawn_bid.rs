use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::ClosePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use solana_sha256_hasher::hashv;

use crate::errors::TenderError;
use crate::state::{BidClosed, BidCommit, BidStatus, ProviderIdentity, Rfp};

/// Phase 2 of withdrawal — base-layer follow-up after `withdraw_bid` undelegate.
///
/// Permitted only when:
///   - Caller signs as the bid's provider (Plain pubkey for L0, sha256 match for L1).
///   - `bid.status == Withdrawn` (set by `withdraw_bid` before its commit_and_undelegate).
///   - `rfp.key() == bid.rfp`.
///
/// Effects:
///   - Closes the BidCommit account; rent refunded to the provider.
///   - Decrements `rfp.bid_count` (saturating).
///   - Emits `BidClosed`.
///
/// Why split from `withdraw_bid`: the magicblock `add_post_commit_actions` runs
/// the action BEFORE the bid's undelegate ownership transfer is visible. Anchor
/// then reports `AccountOwnedByWrongProgram` (#3007) trying to close the bid.
/// A separate base-layer ix sidesteps the timing entirely — by the time the
/// user signs tx 2, the undelegate has fully landed.
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
    /// Closed via CPI below to refund the rent (~0.0048 SOL) to the provider.
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
    let bid = &ctx.accounts.bid;
    match bid.provider_identity {
        ProviderIdentity::Plain(stored) => {
            require_keys_eq!(ctx.accounts.provider.key(), stored, TenderError::NotProvider);
        }
        ProviderIdentity::Hashed(stored_hash) => {
            let h = hashv(&[ctx.accounts.provider.key().as_ref()]).to_bytes();
            require!(h == stored_hash, TenderError::NotProvider);
        }
    }

    // Close the permission account too — its rent (~0.0048 SOL) goes to the
    // provider (who is the `payer` for this CPI). The permission program's
    // ClosePermission ix accepts either `authority` or `permissioned_account`
    // as the signer; we use `provider` (already a tx-level Signer) so no
    // PDA-seeds dance is needed.
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
