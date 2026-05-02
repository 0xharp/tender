use anchor_lang::prelude::*;

/// Singleton platform treasury. Receives 2.5% take rate on each milestone release
/// (in USDC) into its associated token account.
#[account]
#[derive(InitSpace)]
pub struct Treasury {
    pub authority: Pubkey,            // multisig or admin pubkey, set at init
    pub total_collected: u64,         // running total in USDC base units (informational)
    pub bump: u8,
}

pub const TREASURY_SEED: &[u8] = b"treasury";
