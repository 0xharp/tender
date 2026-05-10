use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as sysvar_ix;

use crate::errors::TenderError;
use crate::state::{
    BUYER_REP_SEED, BuyerAttestation, BuyerReputation, BuyerVisibility, Rfp, RfpStatus,
};

/// Solana's built-in Ed25519 signature verification program. Same constant
/// declared in select_bid.rs + attest_win.rs; redeclared here to keep this
/// module self-contained.
const ED25519_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
]);

/// Domain prefix for the buyer-eph binding message — distinct from the
/// bid-binding domain so a signature meant for one ix can never be replayed
/// against the other.
const BUYER_EPH_BINDING_DOMAIN: &[u8] = b"tender-buyer-eph-binding-v1";

/// Buyer who ran a private RFP voluntarily binds it to their main wallet
/// for public reputation credit. One-shot, post-completion. The signer of
/// this tx (= main wallet) is the only on-chain trail between the main
/// wallet and the formerly-anonymous RFP — by design, only created when
/// the buyer explicitly opts in.
///
/// Mechanics:
///   1. The per-RFP ephemeral has a stranded `BuyerReputation` PDA at
///      `[BUYER_REP_SEED, rfp.buyer.as_ref()]` that accumulated all the
///      lifecycle counters (funded_rfps, completed_rfps, etc.) but was
///      never read by anyone.
///   2. The main wallet's `BuyerReputation` PDA at
///      `[BUYER_REP_SEED, main_wallet.key().as_ref()]` is init_if_needed —
///      buyer may have only ever run private RFPs before this attestation.
///   3. The Ed25519SigVerify ix immediately preceding this one in the same
///      tx must contain a valid signature from `main_wallet` over the
///      canonical buyer-eph binding message linking it to `rfp.buyer` (the
///      ephemeral). Without this proof, anyone observing a private RFP
///      complete could race to claim its accrued reputation.
///   4. Atomically merge each counter from the stranded ephemeral rep
///      into the main rep, then set `rfp.buyer_attested = true` to prevent
///      double-credit.
///
/// Symmetric with `attest_win` on the provider side — both gate the
/// rep-merge on a fresh Ed25519 ownership proof signed live by the main
/// wallet at claim time. No cached binding signatures (unlike select_bid's
/// historical envelope-baked binding) — claim-time freshness is simpler
/// and avoids stale-key replay across program upgrades.
///
/// Cherry-picking is allowed by design: the buyer can choose to attest
/// successful RFPs and skip messy ones.
#[derive(Accounts)]
pub struct AttestBuyerHistory<'info> {
    /// The buyer's main wallet — pays tx fee + rent for `main_rep` if it
    /// needs to be initialized, signs the tx envelope, AND signs the
    /// binding message in the prepended Ed25519SigVerify ix.
    #[account(mut)]
    pub main_wallet: Signer<'info>,

    /// The private RFP being attested. Must be `Private` + `Completed` +
    /// not previously attested.
    #[account(mut)]
    pub rfp: Box<Account<'info, Rfp>>,

    /// The stranded per-RFP ephemeral rep account. Read-only — we just
    /// snapshot its counters into `main_rep`. Anchor verifies the seed
    /// derivation, ensuring this is the correct ephemeral's rep PDA.
    #[account(
        seeds = [BUYER_REP_SEED, rfp.buyer.as_ref()],
        bump = ephemeral_rep.bump,
    )]
    pub ephemeral_rep: Box<Account<'info, BuyerReputation>>,

    /// Main wallet's rep account. `init_if_needed` because the buyer may
    /// have only ever run private RFPs before this attestation, in which
    /// case their main rep PDA doesn't exist yet.
    #[account(
        init_if_needed,
        payer = main_wallet,
        space = 8 + BuyerReputation::INIT_SPACE,
        seeds = [BUYER_REP_SEED, main_wallet.key().as_ref()],
        bump,
    )]
    pub main_rep: Box<Account<'info, BuyerReputation>>,

    /// CHECK: instructions sysvar — only read via the `sysvar_ix` helpers
    /// which validate its address. Required to introspect the
    /// Ed25519SigVerify ix that proves `main_wallet → rfp.buyer` binding.
    #[account(address = sysvar_ix::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AttestBuyerHistory>) -> Result<()> {
    require!(
        ctx.accounts.rfp.buyer_visibility == BuyerVisibility::Private,
        TenderError::NotAttestable
    );
    require!(
        ctx.accounts.rfp.status == RfpStatus::Completed,
        TenderError::NotAttestable
    );
    require!(!ctx.accounts.rfp.buyer_attested, TenderError::AlreadyAttested);

    // Verify the prepended Ed25519SigVerify ix proves `main_wallet` signed
    // the canonical buyer-eph binding message naming `rfp.buyer` (the
    // ephemeral). Without this proof, anyone could call attest_buyer_history
    // for any private RFP and steal its accrued reputation.
    verify_buyer_eph_binding_signature(
        &ctx.accounts.instructions_sysvar,
        &ctx.accounts.main_wallet.key(),
        &ctx.accounts.rfp.key(),
        &ctx.accounts.rfp.buyer,
    )?;

    let rfp = &mut ctx.accounts.rfp;
    let now = Clock::get()?.unix_timestamp;
    let eph = &ctx.accounts.ephemeral_rep;
    let main = &mut ctx.accounts.main_rep;

    // Initialize main_rep on first use. The default-pubkey check is
    // Anchor's idiomatic "freshly init'd" sentinel — saves us from
    // tracking a separate "initialized" bool.
    if main.buyer == Pubkey::default() {
        main.buyer = ctx.accounts.main_wallet.key();
        main.bump = ctx.bumps.main_rep;
    }

    // Atomic merge — every counter on the stranded rep is added into
    // the main rep. saturating_add guards against absurd-but-harmless
    // overflow during demo-time stress (in practice u32 counters are
    // far from saturation).
    main.total_rfps = main.total_rfps.saturating_add(eph.total_rfps);
    main.funded_rfps = main.funded_rfps.saturating_add(eph.funded_rfps);
    main.completed_rfps = main.completed_rfps.saturating_add(eph.completed_rfps);
    main.ghosted_rfps = main.ghosted_rfps.saturating_add(eph.ghosted_rfps);
    main.disputed_milestones = main
        .disputed_milestones
        .saturating_add(eph.disputed_milestones);
    main.cancelled_milestones = main
        .cancelled_milestones
        .saturating_add(eph.cancelled_milestones);
    main.total_locked_usdc = main.total_locked_usdc.saturating_add(eph.total_locked_usdc);
    main.total_released_usdc = main
        .total_released_usdc
        .saturating_add(eph.total_released_usdc);
    main.total_refunded_usdc = main
        .total_refunded_usdc
        .saturating_add(eph.total_refunded_usdc);
    main.last_updated = now;

    // Idempotency flag: prevents a second attest call on this RFP from
    // double-crediting the main wallet's rep.
    rfp.buyer_attested = true;

    emit!(BuyerAttestation {
        rfp: rfp.key(),
        buyer_main: ctx.accounts.main_wallet.key(),
        attested_at: now,
    });
    Ok(())
}

/// Same Ed25519SigVerify introspection pattern as attest_win — checks the
/// prepended Ed25519 ix at `current_index - 1` and validates that the
/// signed message is the canonical buyer-eph binding for this (rfp,
/// main_wallet, eph) triple. Re-implemented per ix to keep modules
/// self-contained (the binding domain string differs across ix).
fn verify_buyer_eph_binding_signature(
    instructions_sysvar: &AccountInfo,
    main_wallet: &Pubkey,
    rfp_pda: &Pubkey,
    buyer_eph: &Pubkey,
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
    // byte-level breakdown. Same constants as attest_win.
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
    require!(
        signed_pubkey == main_wallet.to_bytes(),
        TenderError::InvalidAttestation
    );

    // Message must be the canonical buyer-eph binding for this
    // (rfp, main, eph) triple. The eph in the message MUST equal
    // `rfp.buyer` (passed in by the handler) — anchors the proof to the
    // specific RFP's ephemeral so a sig for one RFP can't be replayed
    // against another.
    let actual_message = &data[112..112 + msg_size as usize];
    let expected = build_buyer_eph_binding_message(rfp_pda, main_wallet, buyer_eph);
    require!(
        actual_message == expected.as_slice(),
        TenderError::InvalidAttestation
    );

    Ok(())
}

fn build_buyer_eph_binding_message(rfp: &Pubkey, main: &Pubkey, eph: &Pubkey) -> Vec<u8> {
    // Canonical line-newline format. MUST match the client-side helper
    // in `apps/web/lib/crypto/derive-ephemeral-bid-wallet.ts`
    // (`buildBuyerEphBindingMessage`) byte-for-byte.
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(BUYER_EPH_BINDING_DOMAIN);
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(bs58_encode(&crate::ID.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(bs58_encode(&rfp.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"main=");
    out.extend_from_slice(bs58_encode(&main.to_bytes()).as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"eph=");
    out.extend_from_slice(bs58_encode(&eph.to_bytes()).as_bytes());
    out
}

/// Minimal base58 encoder — same impl as select_bid + attest_win, redeclared
/// to keep this module independent (no shared crate dep just for bs58).
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
    let mut out = String::new();
    for &b in input {
        if b == 0 {
            out.push('1');
        } else {
            break;
        }
    }
    for &d in digits.iter().rev() {
        out.push(ALPHABET[d as usize] as char);
    }
    out
}
