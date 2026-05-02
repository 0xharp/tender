use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct BuyerReputation {
    pub buyer: Pubkey,
    pub total_rfps: u32,
    pub funded_rfps: u32,
    pub completed_rfps: u32,
    pub ghosted_rfps: u32,            // selected winner but never funded
    pub disputed_milestones: u32,     // sum across all RFPs
    pub cancelled_milestones: u32,    // ONLY cancel-with-penalty (post-start cancellations)

    /// Amount tracking - gross USDC base units. Counts mislead at scale
    /// ($100 cancel vs $50,000 cancel look identical); amounts give honest
    /// signal alongside the counts above.
    pub total_locked_usdc: u64,       // sum of contract_values across awards
    pub total_released_usdc: u64,     // sum released to providers (incl. penalty payouts)
    pub total_refunded_usdc: u64,     // sum returned via cancellations

    pub last_updated: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProviderReputation {
    pub provider: Pubkey,             // main wallet (the one credited for wins)
    pub total_wins: u32,
    pub completed_projects: u32,
    pub disputed_milestones: u32,
    pub abandoned_projects: u32,      // provider walked from a project entirely
    /// Number of milestones the provider missed the delivery deadline on.
    /// Incremented by `cancel_late_milestone`. Distinct from `abandoned_projects`
    /// (entire project walked) and `disputed_milestones` (escalated to dispute).
    pub late_milestones: u32,

    /// Amount tracking - gross USDC base units.
    pub total_won_usdc: u64,          // sum of contract_values where provider was selected
    pub total_earned_usdc: u64,       // sum NET received post-fee (incl. penalty payouts)
    pub total_disputed_usdc: u64,     // sum of milestone amounts that hit dispute path

    pub last_updated: i64,
    pub bump: u8,
}

pub const BUYER_REP_SEED: &[u8] = b"buyer_rep";
pub const PROVIDER_REP_SEED: &[u8] = b"provider_rep";

#[event]
pub struct BuyerReputationUpdated {
    pub buyer: Pubkey,
    pub field: u8,                    // 0=total, 1=funded, 2=completed, 3=ghosted, 4=disputed_ms, 5=cancelled_ms
    pub at: i64,
}

#[event]
pub struct ProviderReputationUpdated {
    pub provider: Pubkey,
    pub field: u8,                    // 0=wins, 1=completed_projects, 2=disputed_ms, 3=abandoned
    pub at: i64,
}

#[event]
pub struct WinAttested {
    pub provider_main: Pubkey,
    pub bid: Pubkey,
    pub at: i64,
}
