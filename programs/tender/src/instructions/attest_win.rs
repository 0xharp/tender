use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_ix;

use crate::errors::TenderError;
use crate::state::{
    ATTEST_WIN_RECEIPT_SEED, AttestWinReceipt, BidCommit, BidderVisibility, PROVIDER_REP_SEED,
    ProviderReputation, Rfp, RfpStatus, WinAttested,
};

/// Solana's built-in Ed25519 signature verification program. Same constant
/// declared in select_bid.rs + fund_project.rs; redeclared here to keep
/// this module self-contained.
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

/// Domain prefix for the bid-binding message — must match what
/// `select_bid::verify_binding_signature` expects so providers can reuse the
/// same signature they cached in their bid envelope at submit time.
const BID_BINDING_DOMAIN: &[u8] = b"tender-bid-binding-v1";

/// Provider who won an RFP under their per-RFP bidder ephemeral voluntarily
/// binds it to their main wallet for public reputation credit. Mirrors
/// `attest_buyer_history` but on the provider side and with an extra
/// Ed25519SigVerify proof (the main wallet must demonstrate ownership of the
/// ephemeral that signed the bid; the buyer side doesn't need this because
/// the same wallet plays both signing roles).
///
/// Mechanics:
///   1. The bidder ephemeral has a stranded `ProviderReputation` PDA at
///      `[PROVIDER_REP_SEED, bid.provider.as_ref()]` that accumulated all
///      the win + completion counters but is never referenced by anyone.
///   2. The main wallet's `ProviderReputation` PDA at
///      `[PROVIDER_REP_SEED, main_wallet.key().as_ref()]` is init_if_needed
///      — provider may have only ever bid privately before this attestation.
///   3. The Ed25519SigVerify ix immediately preceding this one in the same
///      tx must contain a valid signature from `main_wallet` over the
///      canonical binding message linking it to `bid` PDA — proves the main
///      wallet authorized the binding (the same message + sig the bidder
///      cached in `_bidBinding` at bid submission time).
///   4. Atomically merge each counter from the eph rep into the main rep,
///      then init the per-bid `AttestWinReceipt` PDA to prevent re-claim.
///
/// **Why the receipt PDA instead of a flag on BidCommit:** `select_bid`
/// delegates the bid to the MagicBlock delegation program so bidders can
/// continue acting on the ephemeral rollup. Once delegated, the tender
/// program no longer owns the account and cannot mutate it from base layer
/// — including any `winner_attested` boolean. The receipt PDA is a separate
/// account this program *does* own; Anchor's `init` constraint rejects the
/// second call with `AccountAlreadyInUse`, giving the same idempotency
/// guarantee the flag would have.
///
/// Cherry-picking allowed: provider can choose which wins to claim and skip
/// messy ones (mirrors attest_buyer_history). Once attested, the link is
/// permanent on chain (the BidCommit PDA + the verified binding sig + the
/// receipt PDA form the public proof).
///
/// Gating: `rfp.status == Completed` AND `rfp.bidder_visibility == BuyerOnly`
/// AND `rfp.winner == Some(bid.key())`. Auto-public RFPs (public bidder mode)
/// don't need claiming — rep already credits main wallet at win time via
/// select_bid's public-mode branch.
///
/// **Why we check `rfp.winner` instead of `bid.status == Selected`:**
/// `select_bid` cannot write `bid.status = Selected` for the same delegation
/// reason above (bid is owned by the delegation program). The on-chain
/// truth that "this bid won" lives at `rfp.winner` — which `select_bid`
/// *can* write because the RFP itself is not delegated. Aligns with the
/// equivalent fix on the frontend (`MyActivityProvider`'s loser-gate).
#[derive(Accounts)]
pub struct AttestWin<'info> {
    /// Provider's main wallet — pays tx fee + rent for `main_rep` if needed
    /// and rent for `claim_receipt`, signs the tx envelope, AND signs the
    /// binding message in the prepended Ed25519SigVerify ix.
    #[account(mut)]
    pub main_wallet: Signer<'info>,

    /// CHECK: read manually because the bid is delegated to the delegation
    /// program (same reason `select_bid` uses AccountInfo here). We
    /// deserialize it in the handler to read `bid.provider` (for the eph
    /// rep PDA derivation check) and `bid.rfp` (to verify it ties to the
    /// rfp account passed in). The `.key()` is used in the seeds of
    /// `claim_receipt` below — Anchor accepts that on AccountInfo.
    pub bid: AccountInfo<'info>,

    /// The RFP this bid won. Read-only — gates on bidder_visibility, status,
    /// and equality of `rfp.winner` to the bid PDA.
    pub rfp: Box<Account<'info, Rfp>>,

    /// CHECK: the bidder ephemeral's stranded provider rep PDA. Validated
    /// in the handler against `[PROVIDER_REP_SEED, bid.provider]` once we've
    /// deserialized the bid (Anchor's `seeds = [...]` constraint can't
    /// reference fields of an AccountInfo, so we do the derivation check
    /// manually). Owner check also happens in handler.
    pub ephemeral_rep: AccountInfo<'info>,

    /// Main wallet's provider rep account. `init_if_needed` because the
    /// provider may have only ever bid privately before this attestation,
    /// in which case their main rep PDA doesn't exist yet.
    #[account(
        init_if_needed,
        payer = main_wallet,
        space = 8 + ProviderReputation::INIT_SPACE,
        seeds = [PROVIDER_REP_SEED, main_wallet.key().as_ref()],
        bump,
    )]
    pub main_rep: Box<Account<'info, ProviderReputation>>,

    /// One-shot receipt PDA — its existence is the idempotency guarantee.
    /// `init` (not `init_if_needed`) so a second attest call on the same
    /// bid fails with `AccountAlreadyInUse` instead of silently merging
    /// rep twice.
    #[account(
        init,
        payer = main_wallet,
        space = 8 + AttestWinReceipt::INIT_SPACE,
        seeds = [ATTEST_WIN_RECEIPT_SEED, bid.key().as_ref()],
        bump,
    )]
    pub claim_receipt: Box<Account<'info, AttestWinReceipt>>,

    /// CHECK: instructions sysvar — we only read it via the `sysvar_ix`
    /// helpers, which validate its address. Required to introspect the
    /// Ed25519SigVerify ix that proves `main_wallet → bid` binding.
    #[account(address = sysvar_ix::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AttestWin>) -> Result<()> {
    let rfp = &ctx.accounts.rfp;
    let bid_pda = ctx.accounts.bid.key();

    // Manually deserialize the bid (it's delegated; Anchor's Account would
    // refuse with AccountOwnedByWrongProgram = 3007). Same pattern as
    // select_bid.rs.
    let bid_data = ctx.accounts.bid.try_borrow_data()?;
    require!(bid_data.len() >= 8, TenderError::InvalidBidStatus);
    let bid: BidCommit = AnchorDeserialize::deserialize(&mut &bid_data[8..])
        .map_err(|_| error!(TenderError::InvalidBidStatus))?;
    drop(bid_data);

    // Tie the bid to this RFP — protects against an attacker pairing an
    // unrelated Completed RFP with someone else's bid.
    require_keys_eq!(bid.rfp, rfp.key(), TenderError::InvalidBidStatus);

    // Gating — private-bidder mode AND completed RFP AND this bid is the
    // recorded winner. The `rfp.winner` check replaces the old
    // `bid.status == Selected` check (which select_bid could never set
    // because the bid is delegated).
    require!(
        rfp.bidder_visibility == BidderVisibility::BuyerOnly,
        TenderError::NotAttestable
    );
    require!(rfp.status == RfpStatus::Completed, TenderError::NotAttestable);
    require!(rfp.winner == Some(bid_pda), TenderError::NotAttestable);

    // Verify the prepended Ed25519SigVerify ix proves `main_wallet` signed
    // the canonical bid-binding message. Reuses the same message format
    // that `select_bid::verify_binding_signature` accepts — providers'
    // bid envelopes already cached this sig at submit time, so they can
    // simply forward it here without resigning.
    verify_binding_signature(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.main_wallet.key(),
        &rfp.key(),
        &bid_pda,
    )?;

    // Validate ephemeral_rep PDA against bid.provider. Done manually
    // because `bid` is AccountInfo and Anchor's `seeds = [...]` clause
    // can't reference fields of an untyped account.
    let (expected_eph_rep, _) = Pubkey::find_program_address(
        &[PROVIDER_REP_SEED, bid.provider.as_ref()],
        ctx.program_id,
    );
    require_keys_eq!(
        ctx.accounts.ephemeral_rep.key(),
        expected_eph_rep,
        TenderError::InvalidAttestation
    );
    require_keys_eq!(
        *ctx.accounts.ephemeral_rep.owner,
        *ctx.program_id,
        TenderError::InvalidAttestation
    );
    let eph_data = ctx.accounts.ephemeral_rep.try_borrow_data()?;
    require!(eph_data.len() >= 8, TenderError::InvalidAttestation);
    let eph: ProviderReputation = AnchorDeserialize::deserialize(&mut &eph_data[8..])
        .map_err(|_| error!(TenderError::InvalidAttestation))?;
    drop(eph_data);

    let now = Clock::get()?.unix_timestamp;
    let main = &mut ctx.accounts.main_rep;

    // Initialize main_rep on first use (default-pubkey sentinel — same
    // pattern as attest_buyer_history).
    if main.provider == Pubkey::default() {
        main.provider = ctx.accounts.main_wallet.key();
        main.bump = ctx.bumps.main_rep;
    }

    // Atomic merge — every counter on the stranded eph rep is added into
    // main rep. saturating_add guards against overflow.
    main.total_wins = main.total_wins.saturating_add(eph.total_wins);
    main.completed_projects = main.completed_projects.saturating_add(eph.completed_projects);
    main.disputed_milestones = main
        .disputed_milestones
        .saturating_add(eph.disputed_milestones);
    main.late_milestones = main.late_milestones.saturating_add(eph.late_milestones);
    main.abandoned_projects = main
        .abandoned_projects
        .saturating_add(eph.abandoned_projects);
    main.total_won_usdc = main.total_won_usdc.saturating_add(eph.total_won_usdc);
    main.total_earned_usdc = main.total_earned_usdc.saturating_add(eph.total_earned_usdc);
    main.total_disputed_usdc = main
        .total_disputed_usdc
        .saturating_add(eph.total_disputed_usdc);
    main.last_updated = now;

    // Receipt PDA — its mere existence is the idempotency proof. Init
    // constraint above already rejected the second call before we got
    // here, so writing the body is just telemetry.
    let receipt = &mut ctx.accounts.claim_receipt;
    receipt.bid = bid_pda;
    receipt.main_wallet = ctx.accounts.main_wallet.key();
    receipt.at = now;
    receipt.bump = ctx.bumps.claim_receipt;

    emit!(WinAttested {
        provider_main: ctx.accounts.main_wallet.key(),
        bid: bid_pda,
        at: now,
    });
    Ok(())
}

/// Same Ed25519SigVerify introspection as `select_bid::verify_binding_signature`
/// — re-implemented here to avoid cross-module crate-internal coupling. Same
/// canonical message format means signatures created at bid-submit time work
/// here without resigning.
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

    // Single-signature Ed25519SigVerify layout — see select_bid for the
    // byte-level breakdown.
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

    // Pubkey in the Ed25519 ix must match the main_wallet claiming credit.
    let signed_pubkey: [u8; 32] = data[80..112].try_into().unwrap();
    require!(signed_pubkey == main_wallet.to_bytes(), TenderError::InvalidAttestation);

    // Message must be the canonical bid-binding string for this (rfp, bid, main).
    let actual_message = &data[112..112 + msg_size as usize];
    let expected = build_binding_message(rfp_pda, bid_pda, main_wallet);
    require!(actual_message == expected.as_slice(), TenderError::InvalidAttestation);

    Ok(())
}

fn build_binding_message(rfp: &Pubkey, bid: &Pubkey, main: &Pubkey) -> Vec<u8> {
    // Format must match `select_bid::build_binding_message` exactly so a
    // signature from one ix is accepted by the other.
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

/// Minimal base58 encoder — same impl as select_bid::bs58_encode (no shared
/// crate dep to keep program lean).
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
    let mut leading_zeros = 0usize;
    for &b in input {
        if b == 0 {
            leading_zeros += 1;
        } else {
            break;
        }
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
