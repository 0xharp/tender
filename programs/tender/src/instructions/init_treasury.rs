use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{Treasury, TREASURY_SEED};

/// One-time setup. Initializes the platform Treasury PDA + its USDC ATA.
/// `authority` is the multisig/admin pubkey that may later be granted token
/// withdrawals (a future ix).
#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Treasury::INIT_SPACE,
        seeds = [TREASURY_SEED],
        bump,
    )]
    pub treasury: Account<'info, Treasury>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[qedgen_macros::qed(verified, spec = "../../tender.qedspec", handler = "init_treasury", hash = "fbf69446fb590dff", spec_hash = "a9e221c13049f191", accounts = "InitTreasury", accounts_file = "src/instructions/init_treasury.rs", accounts_hash = "ffb9404fb8bb34c3")]
pub fn handler(ctx: Context<InitTreasury>, authority: Pubkey) -> Result<()> {
    let t = &mut ctx.accounts.treasury;
    t.authority = authority;
    t.total_collected = 0;
    t.bump = ctx.bumps.treasury;
    Ok(())
}
