use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::instructions::UpdatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::errors::TenderError;
use crate::instructions::delegate_bid::{PER_FLAGS_PROVIDER, PER_FLAGS_READ_ONLY};
use crate::state::{BidCommit, BidStatus, RevealWindowOpened};

/// Permissionless after `bid.bid_close_at`. Adds the buyer to the bid's
/// permission set so they can decrypt the bid envelopes via PER.
#[derive(Accounts)]
pub struct OpenRevealWindow<'info> {
    pub payer: Signer<'info>,

    pub bid: Account<'info, BidCommit>,

    /// CHECK: Permission account, delegated to PER.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, bid.key().as_ref()],
        bump,
        seeds::program = permission_program.key()
    )]
    pub permission: AccountInfo<'info>,

    /// CHECK: Permission program (address-checked).
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,
}

pub fn handler(ctx: Context<OpenRevealWindow>) -> Result<()> {
    let bid = &ctx.accounts.bid;

    let now = Clock::get()?.unix_timestamp;
    require!(now >= bid.bid_close_at, TenderError::BidWindowStillOpen);
    require!(bid.status == BidStatus::Committed, TenderError::InvalidBidStatus);

    let new_members = vec![
        Member { flags: PER_FLAGS_PROVIDER, pubkey: bid.provider },
        Member { flags: PER_FLAGS_READ_ONLY, pubkey: bid.buyer },
    ];

    let bump_arr = [bid.bump];
    let bid_signer_seeds: [&[u8]; 4] = [
        b"bid",
        bid.rfp.as_ref(),
        bid.provider.as_ref(),
        &bump_arr,
    ];

    UpdatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .authority(&bid.to_account_info(), true)
        .permissioned_account(&bid.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .args(MembersArgs { members: Some(new_members) })
        .invoke_signed(&[&bid_signer_seeds])?;

    emit!(RevealWindowOpened {
        bid: bid.key(),
        rfp: bid.rfp,
        buyer: bid.buyer,
        opened_at: now,
    });

    Ok(())
}
