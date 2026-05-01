use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{action, commit};
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use solana_sha256_hasher::hashv;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidSelected, BidStatus, ProviderIdentity, Rfp, RfpStatus};

/// Buyer picks a winner. Runs on the ER. Atomically:
///   1. Verifies caller is the buyer (matches `bid.buyer` snapshot).
///   2. Verifies `provider_wallet` arg matches `bid.provider_identity`
///      (Plain pubkey for L0; sha256 match for L1).
///   3. Sets `bid.status = Selected`.
///   4. Commits bid state back to base layer (KEEPS DELEGATED — losing bids
///      stay sealed under PER permission. Winner stays delegated too in V3;
///      base-layer reads of the bid via the snapshotted state still require
///      the buyer's X25519 priv to decrypt the envelope. Day 7 escrow + Day 9
///      reputation may later add an explicit `publish_winner_bid` ix that
///      undelegates the winner.)
///   5. Schedules a Magic Action `select_bid_finalize` on base layer to set
///      `rfp.winner` + `rfp.status = Awarded`.
///
/// Permitted only while `clock < rfp.reveal_close_at` and
/// `rfp.status == Reveal`. The reveal-window check happens in the action handler
/// (where the rfp is mutable), but the bid-status precondition is checked here.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SelectBidArgs {
    /// The provider's wallet pubkey. Verified against `bid.provider_identity`.
    /// In L1, the buyer learns this by decrypting the buyer envelope after
    /// `open_reveal_window` adds them to the permission set.
    pub provider_wallet: Pubkey,
}

#[commit]
#[derive(Accounts)]
pub struct SelectBid<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(mut)]
    pub bid: Account<'info, BidCommit>,
}

pub fn handler(ctx: Context<SelectBid>, args: SelectBidArgs) -> Result<()> {
    let bid = &mut ctx.accounts.bid;

    require!(
        bid.status == BidStatus::Committed,
        TenderError::InvalidBidStatus
    );
    require_keys_eq!(ctx.accounts.buyer.key(), bid.buyer, TenderError::NotBuyer);

    match bid.provider_identity {
        ProviderIdentity::Plain(stored) => {
            require_keys_eq!(args.provider_wallet, stored, TenderError::NotProvider);
        }
        ProviderIdentity::Hashed(stored_hash) => {
            let h = hashv(&[args.provider_wallet.as_ref()]).to_bytes();
            require!(h == stored_hash, TenderError::NotProvider);
        }
    }

    bid.status = BidStatus::Selected;

    let action_args = ActionArgs::new(anchor_lang::InstructionData::data(
        &crate::instruction::SelectBidFinalize {
            provider_wallet: args.provider_wallet,
        },
    ));
    let action = CallHandler {
        destination_program: crate::ID,
        accounts: vec![
            ShortAccountMeta {
                pubkey: bid.rfp,
                is_writable: true,
            },
            ShortAccountMeta {
                pubkey: bid.key(),
                is_writable: false,
            },
            ShortAccountMeta {
                pubkey: ctx.accounts.buyer.key(),
                is_writable: false,
            },
        ],
        args: action_args,
        escrow_authority: ctx.accounts.buyer.to_account_info(),
        compute_units: 200_000,
    };

    MagicIntentBundleBuilder::new(
        ctx.accounts.buyer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[bid.to_account_info()])
    .add_post_commit_actions([action])
    .build_and_invoke()?;

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Magic Action target (runs on base layer after the ER commit seals).        */
/* -------------------------------------------------------------------------- */

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SelectBidFinalizeArgs {
    pub provider_wallet: Pubkey,
}

#[action]
#[derive(Accounts)]
pub struct SelectBidFinalize<'info> {
    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Account<'info, Rfp>,

    #[account(constraint = bid.rfp == rfp.key() @ TenderError::InvalidRfpStatus)]
    pub bid: Account<'info, BidCommit>,

    /// CHECK: included for buyer-pubkey resolution by `has_one`.
    pub buyer: AccountInfo<'info>,
}

pub fn select_bid_finalize_handler(
    ctx: Context<SelectBidFinalize>,
    provider_wallet: Pubkey,
) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Reveal, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now < rfp.reveal_close_at, TenderError::RevealWindowExpired);

    rfp.winner = Some(provider_wallet);
    rfp.status = RfpStatus::Awarded;

    emit!(BidSelected {
        rfp: rfp.key(),
        bid: ctx.accounts.bid.key(),
        buyer: rfp.buyer,
        provider: provider_wallet,
        selected_at: now,
    });

    Ok(())
}
