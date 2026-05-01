use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use ephemeral_rollups_sdk::access_control::instructions::UpdatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;

use crate::errors::TenderError;
use crate::instructions::delegate_bid::{PER_FLAGS_PROVIDER, PER_FLAGS_READ_ONLY};
use crate::state::{BidCommit, BidStatus, ProviderIdentity, RevealWindowOpened};

/// Opens the reveal window for a single bid by adding the buyer to the
/// permission set. Runs on the ER (permission account is delegated, so
/// `UpdatePermission` confirms in milliseconds).
///
/// Permissionless callable after `bid.bid_close_at` — but the `provider_wallet`
/// arg must be supplied so the new permission set retains the provider:
///   - L0 (`Public`): anyone can read `bid.provider_identity::Plain` and pass it.
///   - L1 (`BuyerOnly`): only the provider knows their own pubkey; in practice
///     they will be the one calling this. The handler hashes the supplied
///     pubkey and verifies it matches `Hashed(...)`.
///
/// `MembersArgs.members` is a *replacement* set, not a delta — so we always
/// pass `[provider, buyer]`, with provider keeping `PROVIDER` flags and buyer
/// receiving `READ_ONLY`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenRevealWindowArgs {
    /// The provider's wallet pubkey. Verified against `bid.provider_identity`
    /// before being included in the new permission set.
    pub provider_wallet: Pubkey,
}

#[derive(Accounts)]
pub struct OpenRevealWindow<'info> {
    /// Anyone — this ix is permissionless once the time gate is satisfied.
    pub payer: Signer<'info>,

    pub bid: Account<'info, BidCommit>,

    /// CHECK: Permission account, delegated to PER. Updated via CPI on the ER.
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

pub fn handler(ctx: Context<OpenRevealWindow>, args: OpenRevealWindowArgs) -> Result<()> {
    let bid = &ctx.accounts.bid;

    // Time gate: this is the entire point of the instruction. Reverts if called
    // before `bid_close_at`, even by an authorized signer.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= bid.bid_close_at, TenderError::BidWindowStillOpen);

    // Bid must be sealed before reveal can open. Initializing-state bids are
    // still mid-write and not safe to expose.
    require!(
        bid.status == BidStatus::Committed,
        TenderError::InvalidBidStatus
    );

    // Verify the supplied provider pubkey matches the on-chain identity binding.
    match bid.provider_identity {
        ProviderIdentity::Plain(stored) => {
            require_keys_eq!(args.provider_wallet, stored, TenderError::NotProvider);
        }
        ProviderIdentity::Hashed(stored_hash) => {
            let h = hashv(&[args.provider_wallet.as_ref()]).to_bytes();
            require!(h == stored_hash, TenderError::NotProvider);
        }
    }

    let new_members = vec![
        Member {
            flags: PER_FLAGS_PROVIDER,
            pubkey: args.provider_wallet,
        },
        Member {
            flags: PER_FLAGS_READ_ONLY,
            pubkey: bid.buyer,
        },
    ];

    // Authority for UpdatePermission is the BidCommit PDA itself — we sign the
    // CPI with its seeds so only our program can mutate the permission set.
    let bid_signer_seeds: &[&[u8]] = &[
        b"bid",
        bid.rfp.as_ref(),
        bid.bid_pda_seed.as_ref(),
        std::slice::from_ref(&bid.bump),
    ];

    UpdatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
        .authority(&bid.to_account_info(), true)
        .permissioned_account(&bid.to_account_info(), true)
        .permission(&ctx.accounts.permission.to_account_info())
        .args(MembersArgs {
            members: Some(new_members),
        })
        .invoke_signed(&[bid_signer_seeds])?;

    emit!(RevealWindowOpened {
        bid: bid.key(),
        rfp: bid.rfp,
        buyer: bid.buyer,
        opened_at: now,
    });

    Ok(())
}
