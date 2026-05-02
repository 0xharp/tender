use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_ix;

use crate::errors::TenderError;
use crate::state::{
    BidCommit, BidSelected, BidStatus, BuyerReputation, BUYER_REP_SEED, BuyerReputationUpdated,
    MAX_MILESTONE_COUNT, MIN_MILESTONE_COUNT, ProviderReputation, PROVIDER_REP_SEED,
    ProviderReputationUpdated, Rfp, RfpStatus, WinnerRecorded,
};

/// Solana's built-in Ed25519 signature verification program.
/// Address: `Ed25519SigVerify111111111111111111111111111`.
pub const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255,
    5, 112, 116, 73, 39, 244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

/// Domain prefix for the binding message that links a bid PDA to a main wallet.
/// Same string also used client-side to construct the message before signing.
pub const BID_BINDING_DOMAIN: &[u8] = b"tender-bid-binding-v1";

/// Buyer awards the winning bid. Base-layer ix.
///
/// Two modes determined by the relationship between bid signer and winner:
///
/// PUBLIC MODE - `args.winner_provider == bid.provider`. The bid was signed
/// by the provider's main wallet. No extra signature needed; the bid signature
/// itself is the ownership proof.
///
/// PRIVATE MODE - `args.winner_provider != bid.provider`. The bid was signed
/// by an ephemeral wallet; the main wallet's identity is encrypted in the bid
/// envelope. To prove the buyer is recording the actual main wallet (not an
/// arbitrary one they made up), the buyer MUST include an Ed25519SigVerify ix
/// at index 0 of the same tx, signing the binding message:
///
///   "tender-bid-binding-v1\nprogram=<id>\nrfp=<rfp>\nbid=<bid>\nmain=<main>"
///
/// The program reads the instructions sysvar, validates the Ed25519SigVerify
/// ix matches expected layout + signed message, and only then accepts
/// args.winner_provider as the main wallet.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SelectBidArgs {
    pub winner_provider: Pubkey,
    pub contract_value: u64,
    /// Number of milestones in the winning bid (1..=MAX_MILESTONE_COUNT).
    /// Sourced by the buyer from the decrypted winning bid plaintext.
    pub milestone_count: u8,
    /// Per-milestone payout amounts (USDC base units). Length equals
    /// `milestone_count`; sum MUST equal `contract_value`. These are the
    /// exact amounts the provider quoted in their bid - no rounding.
    pub milestone_amounts: Vec<u64>,
    /// Per-milestone delivery duration (seconds). Length equals
    /// `milestone_count`. 0 = no deadline (cancel_late_milestone unavailable
    /// for that milestone). Sourced from the bid plaintext if the provider
    /// committed to per-milestone deadlines.
    pub milestone_durations_secs: Vec<i64>,
}

#[derive(Accounts)]
#[instruction(args: SelectBidArgs)]
pub struct SelectBid<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    #[account(
        mut,
        has_one = buyer @ TenderError::NotBuyer,
    )]
    pub rfp: Account<'info, Rfp>,

    /// CHECK: read manually because the bid is delegated to the delegation program.
    pub bid: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, buyer.key().as_ref()],
        bump,
    )]
    pub buyer_reputation: Account<'info, BuyerReputation>,

    /// Provider reputation account. Created lazily on first win - buyer pays
    /// rent. Recording the win here (rather than waiting for first milestone
    /// accept) means `total_won_usdc` reflects awarded contracts even if no
    /// milestones have shipped yet.
    #[account(
        init_if_needed,
        payer = buyer,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, args.winner_provider.as_ref()],
        bump,
    )]
    pub provider_reputation: Account<'info, ProviderReputation>,

    /// CHECK: instructions sysvar - required only when args.winner_provider
    /// differs from bid.provider (private-mode binding-signature verification).
    /// Address-checked when accessed.
    #[account(address = sysvar_ix::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SelectBid>, args: SelectBidArgs) -> Result<()> {
    let rfp = &mut ctx.accounts.rfp;
    require!(
        matches!(rfp.status, RfpStatus::Reveal | RfpStatus::BidsClosed),
        TenderError::InvalidRfpStatus
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now < rfp.reveal_close_at, TenderError::RevealWindowExpired);
    require!(args.contract_value > 0, TenderError::DeclaredAmountMismatch);

    if rfp.reserve_price_revealed > 0 {
        require!(
            args.contract_value <= rfp.reserve_price_revealed,
            TenderError::WinningBidExceedsReserve
        );
    }

    // Validate milestone structure - sourced from the winning bid plaintext
    // and supplied by the buyer at award time.
    require!(
        args.milestone_count >= MIN_MILESTONE_COUNT && args.milestone_count <= MAX_MILESTONE_COUNT,
        TenderError::InvalidMilestoneCount
    );
    require!(
        args.milestone_amounts.len() == args.milestone_count as usize,
        TenderError::InvalidMilestonePercentages
    );
    let amt_sum: u128 = args.milestone_amounts.iter().map(|v| *v as u128).sum();
    require!(amt_sum == args.contract_value as u128, TenderError::InvalidMilestonePercentages);
    require!(args.milestone_amounts.iter().all(|v| *v > 0), TenderError::InvalidMilestonePercentages);
    require!(
        args.milestone_durations_secs.len() == args.milestone_count as usize,
        TenderError::InvalidMilestonePercentages
    );
    require!(
        args.milestone_durations_secs.iter().all(|v| *v >= 0),
        TenderError::InvalidMilestonePercentages
    );

    // Manually deserialize the bid (it's delegated; Anchor's Account would refuse).
    let bid_data = ctx.accounts.bid.try_borrow_data()?;
    require!(bid_data.len() >= 8, TenderError::InvalidBidStatus);
    let bid: BidCommit = AnchorDeserialize::deserialize(&mut &bid_data[8..])
        .map_err(|_| error!(TenderError::InvalidBidStatus))?;
    drop(bid_data);

    require_keys_eq!(bid.rfp, rfp.key(), TenderError::InvalidRfpStatus);
    require_keys_eq!(bid.buyer, ctx.accounts.buyer.key(), TenderError::NotBuyer);
    require!(
        matches!(bid.status, BidStatus::Initializing | BidStatus::Committed),
        TenderError::InvalidBidStatus
    );

    // Mode dispatch: public vs private.
    if args.winner_provider == bid.provider {
        // Public mode: bid was signed by main wallet; no extra proof needed.
    } else {
        // Private mode: verify the Ed25519SigVerify ix at index 0 of this tx
        // proves args.winner_provider signed the canonical binding message.
        verify_binding_signature(
            &ctx.accounts.instructions_sysvar,
            &args.winner_provider,
            &rfp.key(),
            &ctx.accounts.bid.key(),
        )?;
    }

    let mut padded_amounts = [0u64; MAX_MILESTONE_COUNT as usize];
    for (i, v) in args.milestone_amounts.iter().enumerate() {
        padded_amounts[i] = *v;
    }
    let mut padded_durations = [0i64; MAX_MILESTONE_COUNT as usize];
    for (i, v) in args.milestone_durations_secs.iter().enumerate() {
        padded_durations[i] = *v;
    }
    rfp.milestone_count = args.milestone_count;
    rfp.milestone_amounts = padded_amounts;
    rfp.milestone_durations_secs = padded_durations;

    rfp.winner = Some(ctx.accounts.bid.key());
    rfp.winner_provider = Some(args.winner_provider);
    rfp.contract_value = args.contract_value;
    rfp.status = RfpStatus::Awarded;
    rfp.funding_deadline = now + rfp.funding_window_secs;

    let buyer_rep = &mut ctx.accounts.buyer_reputation;
    if buyer_rep.buyer == Pubkey::default() {
        buyer_rep.buyer = ctx.accounts.buyer.key();
        buyer_rep.bump = ctx.bumps.buyer_reputation;
    }
    buyer_rep.total_rfps = buyer_rep.total_rfps.saturating_add(1);
    buyer_rep.total_locked_usdc = buyer_rep.total_locked_usdc.saturating_add(args.contract_value);
    buyer_rep.last_updated = now;
    emit!(BuyerReputationUpdated { buyer: buyer_rep.buyer, field: 0, at: now });

    let provider_rep = &mut ctx.accounts.provider_reputation;
    if provider_rep.provider == Pubkey::default() {
        provider_rep.provider = args.winner_provider;
        provider_rep.bump = ctx.bumps.provider_reputation;
    }
    provider_rep.total_wins = provider_rep.total_wins.saturating_add(1);
    provider_rep.total_won_usdc = provider_rep.total_won_usdc.saturating_add(args.contract_value);
    provider_rep.last_updated = now;
    emit!(ProviderReputationUpdated { provider: provider_rep.provider, field: 0, at: now });

    emit!(BidSelected {
        rfp: rfp.key(),
        bid: ctx.accounts.bid.key(),
        buyer: rfp.buyer,
        provider: args.winner_provider,
        selected_at: now,
    });
    emit!(WinnerRecorded {
        rfp: rfp.key(),
        bid: ctx.accounts.bid.key(),
        buyer: rfp.buyer,
        winner_provider: args.winner_provider,
        contract_value: args.contract_value,
        funding_deadline: rfp.funding_deadline,
    });

    Ok(())
}

/// Reads the instruction immediately preceding `select_bid` in the same tx
/// from the instructions sysvar, verifies it's an Ed25519SigVerify ix with
/// exactly one signature over the canonical binding message linking
/// `main_wallet` to this `bid_pda`.
///
/// We use `current_index - 1` (not a fixed index 0) because most wallets
/// auto-prepend ComputeBudget ixs when signing, which shifts everything down.
/// As long as the buyer's client places the SigVerify ix immediately before
/// select_bid in their build, this lookup is invariant under that prepending.
/// The pubkey + message equality checks below prevent any spoofed sigverify
/// from satisfying us, so scanning by relative position is safe.
fn verify_binding_signature(
    instructions_sysvar: &AccountInfo,
    main_wallet: &Pubkey,
    rfp_pda: &Pubkey,
    bid_pda: &Pubkey,
) -> Result<()> {
    let current_index = sysvar_ix::load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(TenderError::InvalidAttestation))?;
    require!(current_index > 0, TenderError::InvalidAttestation);
    let ix0 = sysvar_ix::load_instruction_at_checked(
        (current_index - 1) as usize,
        instructions_sysvar,
    )
    .map_err(|_| error!(TenderError::InvalidAttestation))?;
    require_keys_eq!(ix0.program_id, ED25519_PROGRAM_ID, TenderError::InvalidAttestation);

    // Ed25519SigVerify data layout (single-signature variant in same ix):
    //   byte 0:        num_signatures (we require 1)
    //   byte 1:        padding
    //   bytes 2..16:   SignatureOffsets struct (14 bytes)
    //                    sig_offset:        u16 LE
    //                    sig_ix_index:      u16 LE (0xFFFF = same ix)
    //                    pubkey_offset:     u16 LE
    //                    pubkey_ix_index:   u16 LE
    //                    msg_offset:        u16 LE
    //                    msg_size:          u16 LE
    //                    msg_ix_index:      u16 LE
    //   bytes 16..80:  signature (64 bytes)
    //   bytes 80..112: pubkey (32 bytes)
    //   bytes 112..:   message
    let data = &ix0.data;
    require!(data.len() >= 16 + 64 + 32, TenderError::InvalidAttestation);
    require!(data[0] == 1, TenderError::InvalidAttestation);

    fn u16_le(b: &[u8], o: usize) -> u16 {
        u16::from_le_bytes([b[o], b[o + 1]])
    }
    let sig_offset = u16_le(data, 2);
    let sig_ix_index = u16_le(data, 4);
    let pubkey_offset = u16_le(data, 6);
    let pubkey_ix_index = u16_le(data, 8);
    let msg_offset = u16_le(data, 10);
    let msg_size = u16_le(data, 12);
    let msg_ix_index = u16_le(data, 14);

    require!(sig_offset == 16, TenderError::InvalidAttestation);
    require!(pubkey_offset == 80, TenderError::InvalidAttestation);
    require!(msg_offset == 112, TenderError::InvalidAttestation);
    require!(sig_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(pubkey_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(msg_ix_index == u16::MAX, TenderError::InvalidAttestation);
    require!(data.len() == 112 + msg_size as usize, TenderError::InvalidAttestation);

    // Verify the pubkey in the Ed25519 ix matches args.winner_provider.
    let signed_pubkey: [u8; 32] = data[80..112].try_into().unwrap();
    require!(signed_pubkey == main_wallet.to_bytes(), TenderError::InvalidAttestation);

    // Build the expected binding message and compare.
    // Format: "tender-bid-binding-v1\nprogram=<id>\nrfp=<rfp>\nbid=<bid>\nmain=<main>"
    let actual_message = &data[112..112 + msg_size as usize];
    let expected = build_binding_message(rfp_pda, bid_pda, main_wallet);
    require!(actual_message == expected.as_slice(), TenderError::InvalidAttestation);

    Ok(())
}

fn build_binding_message(rfp: &Pubkey, bid: &Pubkey, main: &Pubkey) -> Vec<u8> {
    // Use base58 for pubkeys to match what the client signs.
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(BID_BINDING_DOMAIN);
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(bs58_encode(&crate::ID.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(bs58_encode(&rfp.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"bid=");
    out.extend_from_slice(bs58_encode(&bid.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"main=");
    out.extend_from_slice(bs58_encode(&main.to_bytes()).as_bytes());
    out
}

/// Minimal base58 encoder (no external crate to keep the program lean).
/// 32-byte pubkeys always encode to 43-44 chars.
fn bs58_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![0];
    for &b in input {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    // Leading zero bytes → leading '1's
    let mut leading_zeros = 0usize;
    for &b in input {
        if b == 0 { leading_zeros += 1; } else { break; }
    }
    let mut out = String::with_capacity(leading_zeros + digits.len());
    for _ in 0..leading_zeros {
        out.push('1');
    }
    for &d in digits.iter().rev() {
        out.push(ALPHABET[d as usize] as char);
    }
    out
}
