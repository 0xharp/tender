use anchor_lang::prelude::*;

use crate::errors::TenderError;
use crate::state::{BidCommit, BidStatus};

/// Phase 3 of bid submission (runs on the ER, called repeatedly).
///
/// Appends a slice of bytes to either the buyer or provider envelope at the
/// given offset. Provider may call this multiple times to write chunks of each
/// envelope until both reach their declared lengths.
///
/// envelope_kind: 0 = buyer, 1 = provider.
///
/// PER permission membership (provider has AUTHORITY via `delegate_bid`)
/// authorizes the signer; we don't redundantly check ownership in the program.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WriteBidChunkArgs {
    pub envelope_kind: u8,
    pub offset: u32,
    pub data: Vec<u8>,
}

#[derive(Accounts)]
pub struct WriteBidChunk<'info> {
    pub provider: Signer<'info>,

    #[account(mut)]
    pub bid: Account<'info, BidCommit>,
}

pub fn handler(ctx: Context<WriteBidChunk>, args: WriteBidChunkArgs) -> Result<()> {
    let bid = &mut ctx.accounts.bid;
    require!(
        bid.status == BidStatus::Initializing,
        TenderError::InvalidBidStatus
    );

    let (envelope, declared_len) = match args.envelope_kind {
        0 => {
            let len = bid.buyer_envelope_len;
            (&mut bid.buyer_envelope, len)
        }
        1 => {
            let len = bid.provider_envelope_len;
            (&mut bid.provider_envelope, len)
        }
        _ => return err!(TenderError::InvalidEnvelopeKind),
    };

    let offset = args.offset as usize;
    let end = offset
        .checked_add(args.data.len())
        .ok_or(TenderError::ChunkOverrun)?;
    require!(end <= declared_len as usize, TenderError::ChunkOverrun);
    // Allow writes only at or below the current frontier — prevents leaving
    // uninitialized gaps that would silently land in the final hash.
    require!(
        offset <= envelope.len(),
        TenderError::ChunkOffsetOutOfBounds
    );

    if end > envelope.len() {
        envelope.resize(end, 0);
    }
    envelope[offset..end].copy_from_slice(&args.data);

    Ok(())
}
