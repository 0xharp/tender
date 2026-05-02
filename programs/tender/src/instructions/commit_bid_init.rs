use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{
    BidCommit, BidInitialized, BidStatus, MAX_ENVELOPE_LEN, PayoutChain, Rfp, RfpStatus,
};

/// Phase 1 of bid submission (base layer).
///
/// Allocates the `BidCommit` account at the exact size implied by the declared
/// envelope lengths and writes the metadata. Bid PDA is derived from the
/// signer's pubkey directly - no separate seed argument:
///   - Public bidder list: signer = provider's main wallet → bid PDA is
///     enumerable by anyone scanning the program.
///   - Private bidder list: signer = a deterministic ephemeral wallet derived
///     client-side from the provider's main-wallet signature. The ephemeral
///     wallet's pubkey has no other on-chain history; observers see only
///     "an unknown wallet bid here." The provider's main wallet appears
///     nowhere in this ix or the resulting account state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitBidInitArgs {
    pub commit_hash: [u8; 32],
    pub buyer_envelope_len: u32,
    pub provider_envelope_len: u32,
    /// Where milestone USDC lands. Public mode = provider. Private mode =
    /// initially the ephemeral wallet (it gets reset to the main at select).
    pub payout_destination: Pubkey,
    pub payout_chain: PayoutChain,
}

#[derive(Accounts)]
#[instruction(args: CommitBidInitArgs)]
pub struct CommitBidInit<'info> {
    #[account(mut)]
    pub provider: Signer<'info>,

    #[account(mut)]
    pub rfp: Account<'info, Rfp>,

    #[account(
        init,
        payer = provider,
        space = BidCommit::space(args.buyer_envelope_len, args.provider_envelope_len),
        seeds = [b"bid", rfp.key().as_ref(), provider.key().as_ref()],
        bump,
    )]
    pub bid: Account<'info, BidCommit>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CommitBidInit>, args: CommitBidInitArgs) -> Result<()> {
    require!(
        args.buyer_envelope_len > 0 && args.provider_envelope_len > 0,
        TenderError::EnvelopeEmpty
    );
    require!(
        args.buyer_envelope_len <= MAX_ENVELOPE_LEN
            && args.provider_envelope_len <= MAX_ENVELOPE_LEN,
        TenderError::EnvelopeTooLarge
    );

    // V1 only Solana payouts. CrossChain reserved for Day 10 Ika.
    match args.payout_chain {
        PayoutChain::Solana { .. } => {}
        PayoutChain::CrossChain { .. } => {
            return Err(TenderError::CrossChainNotYetSupported.into());
        }
    }

    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Open, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= rfp.bid_open_at, TenderError::BidWindowNotOpen);
    require!(now < rfp.bid_close_at, TenderError::BidWindowClosed);

    let bid = &mut ctx.accounts.bid;
    bid.rfp = rfp.key();
    bid.buyer = rfp.buyer;
    bid.bid_close_at = rfp.bid_close_at;
    bid.provider = ctx.accounts.provider.key();
    bid.commit_hash = args.commit_hash;
    bid.buyer_envelope_len = args.buyer_envelope_len;
    bid.provider_envelope_len = args.provider_envelope_len;
    bid.buyer_envelope = Vec::new();
    bid.provider_envelope = Vec::new();
    bid.submitted_at = now;
    bid.status = BidStatus::Initializing;
    bid.bump = ctx.bumps.bid;
    bid.payout_destination = args.payout_destination;
    bid.payout_chain = args.payout_chain;

    rfp.bid_count = rfp.bid_count.saturating_add(1);

    emit!(BidInitialized {
        bid: bid.key(),
        rfp: rfp.key(),
        buyer_envelope_len: bid.buyer_envelope_len,
        provider_envelope_len: bid.provider_envelope_len,
        initialized_at: now,
    });

    Ok(())
}
