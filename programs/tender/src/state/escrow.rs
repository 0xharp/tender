use anchor_lang::prelude::*;

/// Per-RFP project-level escrow. Holds the contract_value in USDC ATA terms.
/// The actual USDC sits in `escrow_ata = get_associated_token_address(escrow_pda, mint)`.
/// The PDA itself is the authority that can release tokens.
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub rfp: Pubkey,
    pub mint: Pubkey,
    pub total_locked: u64,           // total USDC locked at fund time = rfp.contract_value
    pub total_released: u64,         // sum of milestones released (incl. fees) so far
    pub total_refunded: u64,         // sum of cancel-with-notice + cancel-with-penalty refunds
    pub bump: u8,
    pub funded_at: i64,
}

pub const ESCROW_SEED: &[u8] = b"escrow";
