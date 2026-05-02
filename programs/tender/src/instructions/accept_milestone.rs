use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Escrow, ESCROW_SEED,
    MilestoneAccepted, MilestoneState, MILESTONE_SEED, MilestoneStatus, NO_ACTIVE_MILESTONE,
    ProviderReputation, PROVIDER_REP_SEED, ProviderReputationUpdated, Rfp, RfpCompleted, RfpStatus,
    Treasury, TREASURY_SEED, BPS_DENOMINATOR,
};

/// Buyer accepts a submitted milestone. Releases (amount × (10000 - fee_bps) / 10000)
/// to provider's payout_destination + (amount × fee_bps / 10000) to Treasury ATA.
///
/// Auto-promotes RFP status to Completed when ALL milestones are Released or
/// CancelledByBuyer.
#[derive(Accounts)]
#[instruction(milestone_index: u8)]
pub struct AcceptMilestone<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// `Box<Account>` to keep the 431-byte deserialized Rfp off the stack.
    /// Combined with the boxed token accounts + 2 init_if_needed reputation
    /// accounts below, leaving Rfp on the stack overflows the 4KB Solana
    /// stack frame at runtime ("Access violation in stack frame N"). Same
    /// fix pattern as `fund_project`.
    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Box<Account<'info, Rfp>>,

    #[account(
        mut,
        seeds = [MILESTONE_SEED, rfp.key().as_ref(), &[milestone_index]],
        bump = milestone.bump,
        constraint = milestone.rfp == rfp.key() @ TenderError::InvalidRfpStatus,
        constraint = milestone.index == milestone_index @ TenderError::InvalidMilestoneIndex,
    )]
    pub milestone: Box<Account<'info, MilestoneState>>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump = escrow.bump,
        constraint = escrow.rfp == rfp.key() @ TenderError::InvalidRfpStatus,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    /// Provider's payout_destination ATA. Must match `rfp.winner_provider`.
    /// CHECK validated below by reading `rfp.winner_provider`.
    #[account(
        mut,
        constraint = provider_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = provider_ata.owner == rfp.winner_provider.unwrap_or(Pubkey::default()) @ TenderError::NotProvider,
    )]
    pub provider_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump = treasury.bump,
    )]
    pub treasury: Box<Account<'info, Treasury>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = treasury,
    )]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    /// Provider's main reputation PDA. Required so we can credit the win on
    /// project completion. Created if needed (mode 1 default = main wallet).
    /// For ephemeral modes (2/3) this would be the EPHEMERAL wallet's rep,
    /// In private bidder mode the winner_provider IS the verified main wallet
    /// (cryptographically bound at select_bid via Ed25519SigVerify), so this
    /// is always a public wallet that can build reputation.
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Box<Account<'info, ProviderReputation>>,

    /// Buyer reputation - track total_released_usdc here. Already created by
    /// `select_bid`, so init_if_needed is a no-op in practice.
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump,
    )]
    pub buyer_reputation: Box<Account<'info, BuyerReputation>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AcceptMilestone>, _milestone_index: u8) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Funded | RfpStatus::InProgress),
        TenderError::InvalidRfpStatus
    );

    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Submitted, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    let total = ms.amount;
    let fee = (total as u128 * rfp.fee_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let to_provider = total.checked_sub(fee).ok_or(TenderError::MathOverflow)?;

    // Release tokens from escrow ATA to provider + treasury.
    let rfp_key = rfp.key();
    let escrow_bump = [ctx.accounts.escrow.bump];
    let escrow_seeds: [&[u8]; 3] = [ESCROW_SEED, rfp_key.as_ref(), &escrow_bump];
    let signer_seeds: &[&[&[u8]]] = &[&escrow_seeds];

    if to_provider > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_ata.to_account_info(),
            to: ctx.accounts.provider_ata.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, to_provider, ctx.accounts.mint.decimals)?;
    }

    if fee > 0 {
        let cpi_accounts = TransferChecked {
            from: ctx.accounts.escrow_ata.to_account_info(),
            to: ctx.accounts.treasury_ata.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );
        transfer_checked(cpi_ctx, fee, ctx.accounts.mint.decimals)?;
    }

    ms.status = MilestoneStatus::Released;
    // Free the active-milestone slot so provider can start the next one.
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_released = escrow.total_released.saturating_add(total);

    let treasury = &mut ctx.accounts.treasury;
    treasury.total_collected = treasury.total_collected.saturating_add(fee);

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_earned_usdc = provider_rep.total_earned_usdc.saturating_add(to_provider);
    provider_rep.last_updated = now;

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = ctx.accounts.buyer.key();
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    // Track gross released (provider net + treasury fee) - that's what left escrow.
    buyer_rep.total_released_usdc = buyer_rep.total_released_usdc.saturating_add(total);
    buyer_rep.last_updated = now;

    emit!(MilestoneAccepted {
        rfp: rfp.key(),
        index: ms.index,
        at: now,
        auto_released: false,
        amount_to_provider: to_provider,
        fee_to_treasury: fee,
    });

    // Auto-complete the RFP if every milestone is in a terminal state.
    // NOTE: `total_wins` was already incremented at `select_bid` time - we
    // count wins on award, not on completion. Only `completed_projects` ticks
    // here.
    let total_settled = escrow.total_released
        .saturating_add(escrow.total_refunded);
    if total_settled >= escrow.total_locked {
        rfp.status = RfpStatus::Completed;
        provider_rep.completed_projects = provider_rep.completed_projects.saturating_add(1);
        emit!(ProviderReputationUpdated {
            provider: provider_rep.provider,
            field: 1,
            at: now,
        });
        emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 2, at: now });
        emit!(RfpCompleted { rfp: rfp.key(), at: now });
    }

    Ok(())
}
