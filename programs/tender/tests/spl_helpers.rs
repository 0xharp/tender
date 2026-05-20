//! Test infrastructure for litesvm cover-path tests that need SPL Token +
//! Ed25519 fund-authorization sigverify.
//!
//! Provides the on-chain primitives required by cover paths beyond the
//! simplest (expire / ghosted) — namely SPL mint setup, ATA creation,
//! minting to ATAs, Treasury init, and the byte-level Ed25519SigVerify
//! instruction the program's `fund_project` handler requires.
//!
//! Used by `cover_paths.rs` for the happy-path / cancel / dispute /
//! attestation tests that all need real USDC flow through escrow.

#![allow(dead_code)] // helpers used selectively per test

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey, VerifyingKey};
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use spl_associated_token_account::{
    get_associated_token_address, instruction::create_associated_token_account,
};
use spl_token::{instruction as spl_token_ix, state::Mint};

pub const PROGRAM_SO: &str = "../../target/deploy/tender.so";
pub const SPL_TOKEN_SO: &str = "../../target/deploy/spl_token.so";
pub const ONE_SOL: u64 = 1_000_000_000;
pub const T0: i64 = 1_700_000_000;

// ---------------------------------------------------------------------------
// SVM setup
// ---------------------------------------------------------------------------

/// Fresh SVM with: tender program + SPL Token + SPL Associated Token Account
/// programs loaded. Initial clock at T0. Returns (svm, payer-funded with 100 SOL).
pub fn fresh_svm_with_token() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(tender::ID, PROGRAM_SO).unwrap();
    // SPL Token & ATA programs are built into LiteSVM's defaults (it loads
    // the standard Solana programs automatically). Verify by reading the
    // program account; if absent, fall back to add_program_from_file.
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100 * ONE_SOL).unwrap();
    set_clock(&mut svm, T0);
    (svm, payer)
}

pub fn set_clock(svm: &mut LiteSVM, ts: i64) {
    let mut clock = svm.get_sysvar::<solana_program::clock::Clock>();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

// ---------------------------------------------------------------------------
// PDA derivations (mirror programs/tender/src/state/* seed constants)
// ---------------------------------------------------------------------------

pub fn rfp_pda(buyer: &Pubkey, nonce: &[u8; 8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"rfp", buyer.as_ref(), nonce.as_ref()], &tender::ID)
}

pub fn bid_pda(rfp: &Pubkey, provider: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"bid", rfp.as_ref(), provider.as_ref()], &tender::ID)
}

pub fn escrow_pda(rfp: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"escrow", rfp.as_ref()], &tender::ID)
}

pub fn milestone_pda(rfp: &Pubkey, index: u8) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"milestone", rfp.as_ref(), &[index]],
        &tender::ID,
    )
}

pub fn treasury_pda() -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"treasury"], &tender::ID)
}

pub fn buyer_rep_pda(buyer: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"buyer_rep", buyer.as_ref()], &tender::ID)
}

pub fn provider_rep_pda(provider: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"provider_rep", provider.as_ref()], &tender::ID)
}

// ---------------------------------------------------------------------------
// SPL Token helpers
// ---------------------------------------------------------------------------

/// Create a fresh USDC-like mint with `decimals` decimal places. Returns
/// (mint_keypair, mint_authority_keypair). The mint is initialized and
/// owned by mint_authority.
pub fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8) -> (Keypair, Keypair) {
    let mint = Keypair::new();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), ONE_SOL).unwrap();

    let rent = svm.minimum_balance_for_rent_exemption(Mint::LEN);

    let create_account_ix = solana_sdk::system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        rent,
        Mint::LEN as u64,
        &spl_token::ID,
    );

    let init_mint_ix = spl_token_ix::initialize_mint(
        &spl_token::ID,
        &mint.pubkey(),
        &authority.pubkey(),
        None,
        decimals,
    )
    .unwrap();

    let tx = Transaction::new_signed_with_payer(
        &[create_account_ix, init_mint_ix],
        Some(&payer.pubkey()),
        &[payer, &mint],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("create_mint");
    (mint, authority)
}

/// Create an ATA for `owner` for the given mint. Returns the ATA address.
pub fn create_ata(
    svm: &mut LiteSVM,
    payer: &Keypair,
    owner: &Pubkey,
    mint: &Pubkey,
) -> Pubkey {
    let ata = get_associated_token_address(owner, mint);
    let ix = create_associated_token_account(
        &payer.pubkey(),
        owner,
        mint,
        &spl_token::ID,
    );
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("create_ata");
    ata
}

/// Mint `amount` tokens to `dest_ata`, using `mint_authority` as the signer.
pub fn mint_to(
    svm: &mut LiteSVM,
    mint_authority: &Keypair,
    mint: &Pubkey,
    dest_ata: &Pubkey,
    amount: u64,
) {
    let ix = spl_token_ix::mint_to(
        &spl_token::ID,
        mint,
        dest_ata,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&mint_authority.pubkey()),
        &[mint_authority],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("mint_to");
}

/// Get the token balance of an ATA.
pub fn ata_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let acct = svm.get_account(ata).expect("ata account");
    let token_acct = spl_token::state::Account::unpack(&acct.data).expect("unpack ata");
    token_acct.amount
}

// Re-export for tests
pub use spl_token::state::Account as TokenAccount;
use solana_program::program_pack::Pack;

// ---------------------------------------------------------------------------
// Treasury init
// ---------------------------------------------------------------------------

/// One-time init_treasury call. Creates the singleton treasury PDA + its
/// ATA for `mint`. Authority is the `authority` Pubkey.
pub fn init_treasury(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    authority: Pubkey,
) -> Pubkey {
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, mint);

    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::InitTreasury {
            payer: payer.pubkey(),
            treasury,
            mint: *mint,
            treasury_ata,
            token_program: spl_token::ID,
            associated_token_program: spl_associated_token_account::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::InitTreasury { authority }.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("init_treasury");
    treasury
}

// ---------------------------------------------------------------------------
// Ed25519 SigVerify instruction builders
// ---------------------------------------------------------------------------

/// Solana's built-in Ed25519 sigverify program ID.
pub const ED25519_PROGRAM_ID: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");

/// Build the canonical fund-authorization message that the buyer must sign
/// for `fund_project` to accept their authorization. Matches
/// `build_fund_auth_message` in programs/tender/src/instructions/fund_project.rs:329.
///
/// Format:
///   tender-fund-auth-v1
///   program=<base58 of tender::ID>
///   rfp=<base58 of rfp_pda>
///   contract_value=<decimal>
pub fn build_fund_auth_message(rfp: &Pubkey, contract_value: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(160);
    out.extend_from_slice(b"tender-fund-auth-v1");
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(tender::ID.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(rfp.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"contract_value=");
    out.extend_from_slice(contract_value.to_string().as_bytes());
    out
}

/// Build the canonical bid-binding message for `select_bid` private mode.
/// Matches `build_binding_message` in programs/tender/src/instructions/select_bid.rs:307.
///
/// Format:
///   tender-bid-binding-v1
///   program=<base58 of tender::ID>
///   rfp=<base58 of rfp_pda>
///   bid=<base58 of bid_pda>
///   main=<base58 of main_wallet>
pub fn build_bid_binding_message(rfp: &Pubkey, bid: &Pubkey, main: &Pubkey) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(b"tender-bid-binding-v1");
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(tender::ID.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(rfp.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"bid=");
    out.extend_from_slice(bid.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"main=");
    out.extend_from_slice(main.to_string().as_bytes());
    out
}

/// Convert a Solana Keypair into an ed25519-dalek SigningKey for offline
/// signing. The solana_sdk Keypair stores its bytes as 64-byte
/// (secret || public) — ed25519-dalek's SigningKey takes the first 32.
pub fn signing_key_from_solana_keypair(kp: &Keypair) -> SigningKey {
    let bytes = kp.to_bytes();
    let secret: [u8; 32] = bytes[..32].try_into().expect("32-byte secret");
    SigningKey::from_bytes(&secret)
}

/// Build the Ed25519SigVerify instruction that proves `signer` signed `message`.
/// The byte-level layout matches what `verify_fund_authorization` /
/// `verify_binding_signature` parse on chain (single-signature, same-ix
/// pubkey + message inline).
pub fn build_ed25519_sigverify_ix(signing_key: &SigningKey, message: &[u8]) -> Instruction {
    let signature = signing_key.sign(message);
    let verifying_key: VerifyingKey = signing_key.verifying_key();
    let pubkey_bytes = verifying_key.to_bytes();
    let sig_bytes = signature.to_bytes();

    let mut data = Vec::with_capacity(112 + message.len());
    // byte 0: num_signatures
    data.push(1u8);
    // byte 1: padding
    data.push(0u8);
    // bytes 2-15: SignatureOffsets (14 bytes)
    let sig_offset: u16 = 16;
    let sig_ix_index: u16 = u16::MAX; // same ix
    let pubkey_offset: u16 = 80;
    let pubkey_ix_index: u16 = u16::MAX;
    let msg_offset: u16 = 112;
    let msg_size: u16 = message.len() as u16;
    let msg_ix_index: u16 = u16::MAX;
    data.extend_from_slice(&sig_offset.to_le_bytes());
    data.extend_from_slice(&sig_ix_index.to_le_bytes());
    data.extend_from_slice(&pubkey_offset.to_le_bytes());
    data.extend_from_slice(&pubkey_ix_index.to_le_bytes());
    data.extend_from_slice(&msg_offset.to_le_bytes());
    data.extend_from_slice(&msg_size.to_le_bytes());
    data.extend_from_slice(&msg_ix_index.to_le_bytes());
    // bytes 16-79: signature
    data.extend_from_slice(&sig_bytes);
    // bytes 80-111: pubkey
    data.extend_from_slice(&pubkey_bytes);
    // bytes 112+: message
    data.extend_from_slice(message);

    Instruction {
        program_id: ED25519_PROGRAM_ID,
        accounts: vec![],
        data,
    }
}

// ---------------------------------------------------------------------------
// State fetchers
// ---------------------------------------------------------------------------

pub fn fetch_rfp(svm: &LiteSVM, rfp: &Pubkey) -> tender::state::Rfp {
    let acct = svm.get_account(rfp).expect("rfp account");
    tender::state::Rfp::try_deserialize(&mut &acct.data[..]).expect("rfp deserialize")
}

pub fn fetch_escrow(svm: &LiteSVM, rfp: &Pubkey) -> tender::state::Escrow {
    let (pda, _) = escrow_pda(rfp);
    let acct = svm.get_account(&pda).expect("escrow account");
    tender::state::Escrow::try_deserialize(&mut &acct.data[..]).expect("escrow deserialize")
}

pub fn fetch_milestone(svm: &LiteSVM, rfp: &Pubkey, index: u8) -> tender::state::MilestoneState {
    let (pda, _) = milestone_pda(rfp, index);
    let acct = svm.get_account(&pda).expect("milestone account");
    tender::state::MilestoneState::try_deserialize(&mut &acct.data[..])
        .expect("milestone deserialize")
}

pub fn fetch_treasury(svm: &LiteSVM) -> tender::state::Treasury {
    let (pda, _) = treasury_pda();
    let acct = svm.get_account(&pda).expect("treasury account");
    tender::state::Treasury::try_deserialize(&mut &acct.data[..]).expect("treasury deserialize")
}

pub fn fetch_buyer_rep(svm: &LiteSVM, buyer: &Pubkey) -> tender::state::BuyerReputation {
    let (pda, _) = buyer_rep_pda(buyer);
    let acct = svm.get_account(&pda).expect("buyer_rep account");
    tender::state::BuyerReputation::try_deserialize(&mut &acct.data[..])
        .expect("buyer_rep deserialize")
}

pub fn fetch_provider_rep(svm: &LiteSVM, provider: &Pubkey) -> tender::state::ProviderReputation {
    let (pda, _) = provider_rep_pda(provider);
    let acct = svm.get_account(&pda).expect("provider_rep account");
    tender::state::ProviderReputation::try_deserialize(&mut &acct.data[..])
        .expect("provider_rep deserialize")
}

// ---------------------------------------------------------------------------
// Spec property assertions — Rust mirrors of the qedspec property predicates
// ---------------------------------------------------------------------------

pub mod invariants {
    use super::*;
    use tender::state::{Escrow, Rfp, BPS_DENOMINATOR, NO_ACTIVE_MILESTONE};

    /// `escrow_conservation` — total_released + total_refunded ≤ total_locked.
    pub fn escrow_conservation(escrow: &Escrow) {
        let lhs = escrow.total_released.saturating_add(escrow.total_refunded);
        assert!(
            lhs <= escrow.total_locked,
            "escrow_conservation violated: {} (released) + {} (refunded) > {} (locked)",
            escrow.total_released,
            escrow.total_refunded,
            escrow.total_locked
        );
    }

    /// `fee_bps_bounded` — rfp.fee_bps ≤ BPS_DENOMINATOR.
    pub fn fee_bps_bounded(rfp: &Rfp) {
        assert!(
            rfp.fee_bps as u32 <= BPS_DENOMINATOR as u32,
            "fee_bps_bounded violated: {} > {}",
            rfp.fee_bps,
            BPS_DENOMINATOR
        );
    }

    /// `contract_value_set_on_award` — once awarded/funded/etc., value > 0.
    pub fn contract_value_set_on_award(rfp: &Rfp) {
        use tender::state::RfpStatus;
        if matches!(
            rfp.status,
            RfpStatus::Awarded
                | RfpStatus::Funded
                | RfpStatus::InProgress
                | RfpStatus::Completed
        ) {
            assert!(
                rfp.contract_value > 0,
                "contract_value_set_on_award violated: status={:?} but contract_value=0",
                rfp.status
            );
        }
    }

    /// `escrow_locks_contract_value` — escrow.total_locked == rfp.contract_value.
    pub fn escrow_locks_contract_value(escrow: &Escrow, rfp: &Rfp) {
        assert_eq!(
            escrow.total_locked, rfp.contract_value,
            "escrow_locks_contract_value violated"
        );
    }

    /// `treasury_monotonic` — stateful: treasury.total_collected non-decreasing.
    pub fn treasury_monotonic(prev: u64, curr: u64) {
        assert!(
            curr >= prev,
            "treasury_monotonic violated: {} < {}",
            curr,
            prev
        );
    }

    /// `single_milestone_in_flight` — if active_milestone_index == NO_ACTIVE,
    /// no milestone we're tracking is in Started/Submitted.
    pub fn single_milestone_in_flight(
        rfp: &Rfp,
        milestones: &[(u8, tender::state::MilestoneStatus)],
    ) {
        if rfp.active_milestone_index != NO_ACTIVE_MILESTONE {
            return;
        }
        for (idx, status) in milestones {
            assert!(
                !matches!(
                    status,
                    tender::state::MilestoneStatus::Started
                        | tender::state::MilestoneStatus::Submitted
                ),
                "single_milestone_in_flight violated: ms[{}] is {:?}",
                idx,
                status
            );
        }
    }
}

/// Build the canonical buyer-eph binding message for `attest_buyer_history`.
/// Matches `build_buyer_eph_binding_message` in
/// programs/tender/src/instructions/attest_buyer_history.rs:235.
///
/// Format (line-newline, MUST match byte-for-byte):
///   tender-buyer-eph-binding-v1
///   program=<base58 of tender::ID>
///   rfp=<base58 of rfp PDA>
///   main=<base58 of main_wallet>
///   eph=<base58 of eph wallet>
pub fn build_buyer_eph_binding_message(rfp: &Pubkey, main: &Pubkey, eph: &Pubkey) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    out.extend_from_slice(b"tender-buyer-eph-binding-v1");
    out.push(b'\n');
    out.extend_from_slice(b"program=");
    out.extend_from_slice(tender::ID.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"rfp=");
    out.extend_from_slice(rfp.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"main=");
    out.extend_from_slice(main.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(b"eph=");
    out.extend_from_slice(eph.to_string().as_bytes());
    out
}

/// Derive the AttestWinReceipt PDA — one-shot receipt that gates attest_win
/// idempotency. Seeds: [ATTEST_WIN_RECEIPT_SEED, bid.key()].
pub fn attest_win_receipt_pda(bid: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[tender::state::ATTEST_WIN_RECEIPT_SEED, bid.as_ref()],
        &tender::ID,
    )
}
