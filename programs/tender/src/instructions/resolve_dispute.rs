use anchor_lang::prelude::*;
use anchor_spl::token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked};

use crate::errors::TenderError;
use crate::state::{
    BuyerReputation, BUYER_REP_SEED, DisputeResolved, DisputeSplitProposed, Escrow, ESCROW_SEED,
    MilestoneState, MILESTONE_SEED, MilestoneStatus, NO_ACTIVE_MILESTONE, ProviderReputation,
    PROVIDER_REP_SEED, Rfp, RfpStatus, Treasury, TREASURY_SEED, BPS_DENOMINATOR,
    SPLIT_NOT_PROPOSED,
};

/// Both buyer + provider must call this with the SAME split for it to release.
/// The first call records the proposal; the second call (with matching split)
/// triggers the actual fund flow.
///
/// `split_to_provider_bps`: how much of the milestone amount goes to provider
/// (0 = nothing, 10000 = all). Buyer keeps `(10000 - split) * amount / 10000`.
/// Platform fee still applies to the provider's share.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ResolveDisputeArgs {
    pub split_to_provider_bps: u16,
}

#[derive(Accounts)]
#[instruction(milestone_index: u8, args: ResolveDisputeArgs)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub party: Signer<'info>,

    #[account(mut)]
    pub rfp: Box<Account<'info, Rfp>>,

    #[account(
        mut,
        seeds = [MILESTONE_SEED, rfp.key().as_ref(), &[milestone_index]],
        bump = milestone.bump,
    )]
    pub milestone: Account<'info, MilestoneState>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, rfp.key().as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub escrow_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = provider_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = provider_ata.owner == rfp.winner_provider.unwrap_or(Pubkey::default()) @ TenderError::NotProvider,
    )]
    pub provider_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = buyer_ata.mint == mint.key() @ TenderError::InvalidRfpStatus,
        constraint = buyer_ata.owner == rfp.buyer @ TenderError::NotBuyer,
    )]
    pub buyer_ata: Box<Account<'info, TokenAccount>>,

    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = treasury)]
    pub treasury_ata: Box<Account<'info, TokenAccount>>,

    /// Both rep accounts so we can update amount trackers + the dispute counters.
    #[account(
        init_if_needed,
        payer = party,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, rfp.buyer.as_ref()],
        bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    #[account(
        init_if_needed,
        payer = party,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, rfp.winner_provider.unwrap_or(Pubkey::default()).as_ref()],
        bump,
    )]
    pub provider_reputation: Account<'info, ProviderReputation>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ResolveDispute>,
    _milestone_index: u8,
    args: ResolveDisputeArgs,
) -> Result<()> {
    require!(args.split_to_provider_bps <= BPS_DENOMINATOR, TenderError::InvalidSplit);

    let rfp = &mut ctx.accounts.rfp;
    let ms = &mut ctx.accounts.milestone;
    require!(ms.status == MilestoneStatus::Disputed, TenderError::InvalidMilestoneStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now <= ms.dispute_deadline, TenderError::DisputeCooloffExpired);

    let signer = ctx.accounts.party.key();
    let is_buyer = signer == rfp.buyer;
    let is_provider = Some(signer) == rfp.winner_provider;
    require!(is_buyer || is_provider, TenderError::NotDisputeParty);

    if is_buyer {
        ms.buyer_proposed_split_bps = args.split_to_provider_bps;
    } else {
        ms.provider_proposed_split_bps = args.split_to_provider_bps;
    }
    emit!(DisputeSplitProposed {
        rfp: rfp.key(),
        index: ms.index,
        party: signer,
        split_to_provider_bps: args.split_to_provider_bps,
        at: now,
    });

    let buyer_done = ms.buyer_proposed_split_bps != SPLIT_NOT_PROPOSED;
    let provider_done = ms.provider_proposed_split_bps != SPLIT_NOT_PROPOSED;

    if !(buyer_done && provider_done) {
        return Ok(());                            // wait for the other side
    }
    require!(
        ms.buyer_proposed_split_bps == ms.provider_proposed_split_bps,
        TenderError::SplitMismatch
    );

    // Execute the split.
    let amount = ms.amount;
    let split_to_provider = (amount as u128 * args.split_to_provider_bps as u128
        / BPS_DENOMINATOR as u128) as u64;
    let to_buyer_refund = amount.saturating_sub(split_to_provider);
    let fee = (split_to_provider as u128 * rfp.fee_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let to_provider_net = split_to_provider.saturating_sub(fee);

    let rfp_key = rfp.key();
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, rfp_key.as_ref(), &[ctx.accounts.escrow.bump]];

    if to_provider_net > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.provider_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            to_provider_net,
            ctx.accounts.mint.decimals,
        )?;
    }
    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.treasury_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            fee,
            ctx.accounts.mint.decimals,
        )?;
    }
    if to_buyer_refund > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.escrow_ata.to_account_info(),
                    to: ctx.accounts.buyer_ata.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
                &[escrow_seeds],
            ),
            to_buyer_refund,
            ctx.accounts.mint.decimals,
        )?;
    }

    ms.status = MilestoneStatus::DisputeResolved;
    // Free the active-milestone slot now that the dispute is resolved.
    rfp.active_milestone_index = NO_ACTIVE_MILESTONE;
    let escrow = &mut ctx.accounts.escrow;
    escrow.total_released = escrow.total_released.saturating_add(split_to_provider);
    escrow.total_refunded = escrow.total_refunded.saturating_add(to_buyer_refund);

    let treasury = &mut ctx.accounts.treasury;
    treasury.total_collected = treasury.total_collected.saturating_add(fee);

    // Reputation amount tracking. The dispute outcome counts in both parties'
    // amount fields (gross released to provider + gross refunded to buyer);
    // the milestone amount also lands in `total_disputed_usdc` so the
    // dispute history is queryable per-provider.
    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = rfp.buyer;
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    buyer_rep.total_released_usdc = buyer_rep.total_released_usdc.saturating_add(split_to_provider);
    buyer_rep.total_refunded_usdc = buyer_rep.total_refunded_usdc.saturating_add(to_buyer_refund);
    buyer_rep.last_updated = now;

    let provider_rep = &mut ctx.accounts.provider_reputation;
    let main_wallet = rfp.winner_provider.unwrap_or(Pubkey::default());
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = main_wallet;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_earned_usdc = provider_rep.total_earned_usdc.saturating_add(to_provider_net);
    provider_rep.total_disputed_usdc = provider_rep.total_disputed_usdc.saturating_add(amount);
    provider_rep.last_updated = now;

    if escrow.total_released.saturating_add(escrow.total_refunded) >= escrow.total_locked {
        rfp.status = RfpStatus::Completed;
    } else {
        rfp.status = RfpStatus::InProgress;
    }

    emit!(DisputeResolved {
        rfp: rfp.key(),
        index: ms.index,
        split_to_provider_bps: args.split_to_provider_bps,
        provider_amount: to_provider_net,
        buyer_refund: to_buyer_refund,
        fee_to_treasury: fee,
        at: now,
        default_applied: false,
    });
    Ok(())
}
