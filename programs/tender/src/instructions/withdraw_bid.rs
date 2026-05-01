use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::CommitAndUndelegatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use solana_sha256_hasher::hashv;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidStatus, BidWithdrawn, ProviderIdentity};

/// Provider-initiated bid withdrawal — phase 1 of 2 (ER side).
///
/// Atomically:
///   1. Validates provider identity binding (Plain match for L0, sha256 for L1).
///   2. Sets `bid.status = Withdrawn` (committed back to base layer with the bid).
///   3. Releases the permission account back to base layer.
///   4. Commits + undelegates the BidCommit account back to base layer.
///
/// Permitted only while `clock < bid.bid_close_at`.
///
/// Phase 2 (`close_withdrawn_bid`) runs as a SEPARATE base-layer tx after the
/// undelegate seals — it closes the BidCommit (refunds rent to provider) and
/// decrements `rfp.bid_count`. We split into two ix because the magicblock
/// Magic Action runs the close BEFORE the undelegate ownership transfer is
/// visible, which trips Anchor's account-owner check (#3007) and silently
/// leaves the bid PDA stuck on-chain.
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

    // Snapshot bid fields we'll need for the signer-seeds. We can't hold a
    // borrow across `commit_and_undelegate` (which consumes the AccountInfo).
    let bid_pda_seed_arr: [u8; 32];
    let bid_bump_arr: [u8; 1];
    let bid_rfp;
    {
        let bid = &ctx.accounts.bid;
        require!(
            matches!(bid.status, BidStatus::Initializing | BidStatus::Committed),
            TenderError::BidNotWithdrawable
        );
        require!(now < bid.bid_close_at, TenderError::BidWindowClosed);

        match bid.provider_identity {
            ProviderIdentity::Plain(stored) => {
                require_keys_eq!(ctx.accounts.provider.key(), stored, TenderError::NotProvider);
            }
            ProviderIdentity::Hashed(stored_hash) => {
                let h = hashv(&[ctx.accounts.provider.key().as_ref()]).to_bytes();
                require!(h == stored_hash, TenderError::NotProvider);
            }
        }

        bid_pda_seed_arr = bid.bid_pda_seed;
        bid_bump_arr = [bid.bump];
        bid_rfp = bid.rfp;
    }
    let bid_signer_seeds: [&[u8]; 4] = [
        b"bid",
        bid_rfp.as_ref(),
        bid_pda_seed_arr.as_ref(),
        bid_bump_arr.as_ref(),
    ];

    // Flip status BEFORE the commit so the snapshot lands on base layer with
    // status = Withdrawn — `close_withdrawn_bid` requires this.
    //
    // The follow-up `exit(&crate::ID)?` is REQUIRED. Without it, the in-memory
    // status mutation hasn't been serialized to the account bytes when the CPI
    // runs — so commit_and_undelegate reads the OLD bytes (status=Committed)
    // and Solana's post-tx check then fires "External Account Data Modified"
    // because Anchor's auto-exit tries to write our dirty in-memory state on
    // top of the CPI-modified account. The magicblock private-counter example
    // shows this same pattern (`counter.exit(&crate::ID)?`).
    {
        let bid = &mut ctx.accounts.bid;
        bid.status = BidStatus::Withdrawn;
    }
    ctx.accounts.bid.exit(&crate::ID)?;

    // 1. Release the permission account.
    CommitAndUndelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .authority(&ctx.accounts.provider.to_account_info(), true)
        .permissioned_account(&ctx.accounts.bid.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .magic_context(&ctx.accounts.magic_context.to_account_info())
        .magic_program(&ctx.accounts.magic_program.to_account_info())
        .invoke_signed(&[&bid_signer_seeds])?;

    // 2. Commit + undelegate the bid back to base layer. NO Magic Action — the
    // close happens in a separate base-layer tx via `close_withdrawn_bid` after
    // this seal completes. See module doc for the why.
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
