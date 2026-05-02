use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated, Escrow, ESCROW_SEED, MilestoneState,
    MILESTONE_SEED, MilestoneStatus, Rfp, RfpFunded, RfpStatus, SPLIT_NOT_PROPOSED,
};

/// Buyer locks the full contract_value into escrow + initializes all milestone
/// PDAs at amounts derived from `rfp.milestone_percentages`.
///
/// Must be called within `rfp.funding_deadline`. After this ix:
///   - rfp.status = Funded
///   - escrow ATA holds contract_value of mint
///   - all milestones exist in Pending status with their target amounts
///
/// Note: this ix uses `init_if_needed` on the milestone PDAs so it's idempotent
/// at the milestone-init layer. The token transfer is NOT idempotent - calling
/// twice would attempt to transfer twice. Status check (must be Awarded) blocks
/// double-fund.
#[derive(Accounts)]
#[instruction()]
pub struct FundProject<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// `Box<Account>` (instead of plain `Account`) heap-allocates the
    /// deserialized struct - critical here because `Rfp` is now 431 bytes
    /// and Anchor's expanded `try_accounts` function would otherwise put it
    /// directly on the 4KB Solana stack frame. Combined with the other
    /// stack-allocated accounts below (escrow init + ATA init + reputation),
    /// the un-boxed version overflows the stack with "Access violation in
    /// stack frame N" at runtime. Same pattern applied to every other heavy
    /// account in this struct.
    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Box<Account<'info, Rfp>>,

    pub mint: Box<Account<'info, Mint>>,

    /// Source ATA: buyer's USDC.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = buyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = buyer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump,
    )]
    pub escrow: Box<Account<'info, Escrow>>,

    /// Escrow ATA: the PDA that will hold the locked USDC.
    #[account(
        init,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump = buyer_reputation.bump,
    )]
    pub buyer_reputation: Box<Account<'info, BuyerReputation>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, FundProject<'info>>) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Awarded, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= rfp.funding_deadline, TenderError::FundingWindowExpired);

    let contract_value = rfp.contract_value;
    require!(contract_value > 0, TenderError::DeclaredAmountMismatch);

    // Initialize escrow.
    let escrow = &mut ctx.accounts.escrow;
    escrow.rfp = rfp.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.total_locked = contract_value;
    escrow.total_released = 0;
    escrow.total_refunded = 0;
    escrow.bump = ctx.bumps.escrow;
    escrow.funded_at = now;

    // Move USDC from buyer to escrow ATA.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.buyer_ata.to_account_info(),
        to: ctx.accounts.escrow_ata.to_account_info(),
        authority: ctx.accounts.buyer.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, contract_value, ctx.accounts.mint.decimals)?;

    // Initialize each milestone PDA. We need to do this via remaining_accounts
    // because we don't know how many milestones there are at compile time.
    // remaining_accounts layout: [ms_0, ms_1, ..., ms_{milestone_count-1}].
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() == rfp.milestone_count as usize, TenderError::InvalidMilestoneCount);

    for (i, ms_account_info) in remaining.iter().enumerate() {
        let amount = rfp.milestone_amounts[i];

        // Verify the PDA derivation.
        let (expected_pda, bump) = Pubkey::find_program_address(
            &[MILESTONE_SEED, rfp.key().as_ref(), &[i as u8]],
            &crate::ID,
        );
        require_keys_eq!(*ms_account_info.key, expected_pda, TenderError::InvalidMilestoneIndex);

        // Create the account via system_program CPI with PDA signer.
        let space = 8 + MilestoneState::INIT_SPACE;
        let lamports = Rent::get()?.minimum_balance(space);
        let rfp_key = rfp.key();
        let signer_seeds: &[&[u8]] = &[MILESTONE_SEED, rfp_key.as_ref(), &[i as u8], &[bump]];

        let create_ix = anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.buyer.key(),
            &expected_pda,
            lamports,
            space as u64,
            &crate::ID,
        );
        anchor_lang::solana_program::program::invoke_signed(
            &create_ix,
            &[
                ctx.accounts.buyer.to_account_info(),
                ms_account_info.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;

        // Write initial state. delivery_deadline stays 0 here; start_milestone
        // sets it once the provider commits.
        let ms = MilestoneState {
            rfp: rfp.key(),
            index: i as u8,
            amount,
            status: MilestoneStatus::Pending,
            iteration_count: 0,
            started_at: 0,
            submitted_at: 0,
            review_deadline: 0,
            disputed_at: 0,
            dispute_deadline: 0,
            bump,
            buyer_proposed_split_bps: SPLIT_NOT_PROPOSED,
            provider_proposed_split_bps: SPLIT_NOT_PROPOSED,
            delivery_deadline: 0,
        };
        let mut data = ms_account_info.try_borrow_mut_data()?;
        // Anchor account discriminator first 8 bytes.
        data[..8].copy_from_slice(&MilestoneState::DISCRIMINATOR);
        let mut cursor: &mut [u8] = &mut data[8..];
        ms.serialize(&mut cursor)?;
    }

    rfp.status = RfpStatus::Funded;

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    buyer_rep.funded_rfps = buyer_rep.funded_rfps.saturating_add(1);
    buyer_rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 1, at: now });

    emit!(RfpFunded {
        rfp: rfp.key(),
        buyer: rfp.buyer,
        contract_value,
        funded_at: now,
    });
    Ok(())
}
