use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::errors::TenderError;
use crate::state::{
    BidCommit, BidInitialized, BidStatus, BidderVisibility, MAX_ENVELOPE_LEN, ProviderIdentity,
    Rfp, RfpStatus,
};

/// Phase 1 of bid submission (base layer).
///
/// Allocates the `BidCommit` account at the exact size implied by the declared
/// envelope lengths, writes the metadata (commit_hash, identity binding,
/// bid_pda_seed), and sets `status = Initializing`. Envelope bytes are written
/// in subsequent ER `write_bid_chunk` calls and sealed by `finalize_bid`.
///
/// Bid_pda_seed semantics:
/// - L0 (`Public`):     must equal `provider.key().to_bytes()` (enforced here).
/// - L1 (`BuyerOnly`):  free-form 32 bytes — provider derives deterministically
///                      from `sha256(walletSig(BID_PDA_SEED_DOMAIN || rfp_nonce))`
///                      so the seed is unguessable to outside observers.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitBidInitArgs {
    pub bid_pda_seed: [u8; 32],
    pub commit_hash: [u8; 32],
    pub buyer_envelope_len: u32,
    pub provider_envelope_len: u32,
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
        seeds = [b"bid", rfp.key().as_ref(), args.bid_pda_seed.as_ref()],
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

    let rfp = &mut ctx.accounts.rfp;
    require!(rfp.status == RfpStatus::Open, TenderError::InvalidRfpStatus);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= rfp.bid_open_at, TenderError::BidWindowNotOpen);
    require!(now < rfp.bid_close_at, TenderError::BidWindowClosed);

    // Identity binding + L0 seed validation depend on the RFP's privacy mode.
    let provider_identity = match rfp.bidder_visibility {
        BidderVisibility::Public => {
            // L0: bid PDA seed MUST equal the provider wallet bytes — the seed
            // IS the identity, so any other value would let one provider stake
            // multiple PDAs per RFP.
            require!(
                args.bid_pda_seed == ctx.accounts.provider.key().to_bytes(),
                TenderError::InvalidBidSeedForPublicMode
            );
            ProviderIdentity::Plain(ctx.accounts.provider.key())
        }
        BidderVisibility::BuyerOnly => {
            // L1: store sha256(provider_wallet) so withdraw/select can authenticate
            // by hashing the signer. The seed itself stays observer-opaque.
            let h = hashv(&[ctx.accounts.provider.key().as_ref()]);
            ProviderIdentity::Hashed(h.to_bytes())
        }
    };

    let bid = &mut ctx.accounts.bid;
    bid.rfp = rfp.key();
    bid.buyer = rfp.buyer;
    bid.bid_close_at = rfp.bid_close_at;
    bid.bid_pda_seed = args.bid_pda_seed;
    bid.provider_identity = provider_identity;
    bid.commit_hash = args.commit_hash;
    bid.buyer_envelope_len = args.buyer_envelope_len;
    bid.provider_envelope_len = args.provider_envelope_len;
    bid.buyer_envelope = Vec::new();
    bid.provider_envelope = Vec::new();
    bid.submitted_at = now;
    bid.status = BidStatus::Initializing;
    bid.bump = ctx.bumps.bid;

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
