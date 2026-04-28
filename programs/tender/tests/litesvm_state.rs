//! Rust LiteSVM tests for low-level state transitions + arithmetic invariants.
//!
//! Coverage focus per agreed split:
//!   - state machine (Open → Reveal, no backward transitions, no double-close)
//!   - bid_count saturating_add / saturating_sub correctness
//!   - PDA bump derivation stored on-account matches Pubkey::find_program_address
//!
//! Full instruction-flow coverage (happy path + every error code) lives in the
//! TS LiteSVM suite at tests/litesvm/.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use tender::state::{Rfp, RfpStatus};

const PROGRAM_SO: &str = "../../target/deploy/tender.so";
const ONE_SOL: u64 = 1_000_000_000;
const T0: i64 = 1_700_000_000;

fn fresh_svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(tender::ID, PROGRAM_SO).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10 * ONE_SOL).unwrap();
    set_clock(&mut svm, T0);
    (svm, payer)
}

fn set_clock(svm: &mut LiteSVM, ts: i64) {
    let mut clock = svm.get_sysvar::<solana_program::clock::Clock>();
    clock.unix_timestamp = ts;
    svm.set_sysvar(&clock);
}

fn rfp_pda(buyer: &Pubkey, nonce: &[u8; 8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"rfp", buyer.as_ref(), nonce.as_ref()], &tender::ID)
}

fn bid_pda(rfp: &Pubkey, provider: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"bid", rfp.as_ref(), provider.as_ref()], &tender::ID)
}

fn default_rfp_args(nonce: [u8; 8]) -> tender::instructions::rfp_create::RfpCreateArgs {
    tender::instructions::rfp_create::RfpCreateArgs {
        rfp_nonce: nonce,
        buyer_encryption_pubkey: [1u8; 32],
        title_hash: [2u8; 32],
        category: 0,
        budget_max: 50_000_000_000,
        bid_open_at: T0,
        bid_close_at: T0 + 86_400,
        reveal_close_at: T0 + 86_400 * 3,
        milestone_count: 3,
    }
}

fn create_rfp(svm: &mut LiteSVM, buyer: &Keypair, nonce: [u8; 8]) -> Pubkey {
    let (rfp, _bump) = rfp_pda(&buyer.pubkey(), &nonce);
    let args = default_rfp_args(nonce);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::RfpCreate {
            buyer: buyer.pubkey(),
            rfp,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::RfpCreate { args }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("rfp_create should succeed");
    rfp
}

fn commit_bid(svm: &mut LiteSVM, rfp: Pubkey, provider: &Keypair, hash_seed: u8) {
    let (bid, _) = bid_pda(&rfp, &provider.pubkey());
    let args = tender::instructions::commit_bid::CommitBidArgs {
        commit_hash: [hash_seed; 32],
        ciphertext_storage_uri: format!("ipfs://test-{hash_seed}"),
    };
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::CommitBid {
            provider: provider.pubkey(),
            rfp,
            bid,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::CommitBid { args }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[provider],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("commit_bid should succeed");
}

fn withdraw_bid(svm: &mut LiteSVM, rfp: Pubkey, provider: &Keypair) {
    let (bid, _) = bid_pda(&rfp, &provider.pubkey());
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::WithdrawBid {
            provider: provider.pubkey(),
            rfp,
            bid,
        }
        .to_account_metas(None),
        data: tender::instruction::WithdrawBid {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[provider],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("withdraw_bid should succeed");
}

fn select_bid(svm: &mut LiteSVM, buyer: &Keypair, rfp: Pubkey, provider: Pubkey) -> bool {
    let (bid, _) = bid_pda(&rfp, &provider);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::SelectBid {
            buyer: buyer.pubkey(),
            rfp,
            bid,
        }
        .to_account_metas(None),
        data: tender::instruction::SelectBid {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).is_ok()
}

fn close_bidding(svm: &mut LiteSVM, rfp: Pubkey, signer: &Keypair) -> bool {
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::RfpCloseBidding {
            anyone: signer.pubkey(),
            rfp,
        }
        .to_account_metas(None),
        data: tender::instruction::RfpCloseBidding {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&signer.pubkey()),
        &[signer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).is_ok()
}

fn read_rfp(svm: &LiteSVM, rfp: Pubkey) -> Rfp {
    let account = svm.get_account(&rfp).expect("rfp account should exist");
    Rfp::try_deserialize(&mut account.data.as_ref()).expect("rfp should deserialize")
}

fn fund(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 10 * ONE_SOL).unwrap();
    kp
}

// -----------------------------------------------------------------------------
// PDA + bump derivation
// -----------------------------------------------------------------------------

#[test]
fn rfp_pda_bump_matches_stored_bump() {
    let (mut svm, buyer) = fresh_svm();
    let nonce = [42u8; 8];
    let (expected_pda, expected_bump) = rfp_pda(&buyer.pubkey(), &nonce);
    let rfp = create_rfp(&mut svm, &buyer, nonce);
    assert_eq!(rfp, expected_pda, "PDA address must match find_program_address");

    let state = read_rfp(&svm, rfp);
    assert_eq!(state.bump, expected_bump, "stored bump must match canonical bump");
    assert_eq!(state.buyer, buyer.pubkey());
    assert_eq!(state.status, RfpStatus::Open);
    assert_eq!(state.bid_count, 0);
}

#[test]
fn rfp_create_initializes_optional_fields_correctly() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    let state = read_rfp(&svm, rfp);
    assert_eq!(state.winner, None, "winner must start as None");
    assert_eq!(state.escrow_vault, Pubkey::default(), "escrow_vault filled at escrow_fund");
    assert_eq!(state.created_at, T0);
}

// -----------------------------------------------------------------------------
// Arithmetic invariants: bid_count saturating add/sub
// -----------------------------------------------------------------------------

#[test]
fn bid_count_increments_per_commit() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 0);

    let p1 = fund(&mut svm);
    commit_bid(&mut svm, rfp, &p1, 1);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 1);

    let p2 = fund(&mut svm);
    commit_bid(&mut svm, rfp, &p2, 2);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 2);

    let p3 = fund(&mut svm);
    commit_bid(&mut svm, rfp, &p3, 3);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 3);
}

#[test]
fn bid_count_decrements_on_withdraw_and_floors_at_zero() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);

    let p1 = fund(&mut svm);
    commit_bid(&mut svm, rfp, &p1, 1);
    let p2 = fund(&mut svm);
    commit_bid(&mut svm, rfp, &p2, 2);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 2);

    withdraw_bid(&mut svm, rfp, &p1);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 1);

    withdraw_bid(&mut svm, rfp, &p2);
    assert_eq!(
        read_rfp(&svm, rfp).bid_count,
        0,
        "saturating_sub must not underflow"
    );
}

// -----------------------------------------------------------------------------
// State machine transitions
// -----------------------------------------------------------------------------

#[test]
fn close_bidding_transitions_open_to_reveal() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Open);

    set_clock(&mut svm, T0 + 86_400 + 1);
    assert!(close_bidding(&mut svm, rfp, &buyer), "close should succeed past bid_close_at");
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Reveal);
}

#[test]
fn close_bidding_idempotency_blocked_by_status_check() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    set_clock(&mut svm, T0 + 86_400 + 1);
    assert!(close_bidding(&mut svm, rfp, &buyer));
    assert!(
        !close_bidding(&mut svm, rfp, &buyer),
        "second close must fail (status no longer Open)"
    );
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Reveal);
}

#[test]
fn close_bidding_anyone_signer() {
    // Permissionless: any signer can call close, not just the buyer.
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    let stranger = fund(&mut svm);
    set_clock(&mut svm, T0 + 86_400 + 1);
    assert!(
        close_bidding(&mut svm, rfp, &stranger),
        "non-buyer signer must be allowed to close"
    );
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Reveal);
}

// -----------------------------------------------------------------------------
// select_bid: state machine + authorization
// -----------------------------------------------------------------------------

fn rfp_in_reveal(svm: &mut LiteSVM, buyer: &Keypair) -> (Pubkey, Keypair) {
    let rfp = create_rfp(svm, buyer, [9u8; 8]);
    let provider = fund(svm);
    commit_bid(svm, rfp, &provider, 1);
    set_clock(svm, T0 + 86_400 + 1);
    assert!(close_bidding(svm, rfp, buyer));
    assert_eq!(read_rfp(svm, rfp).status, RfpStatus::Reveal);
    (rfp, provider)
}

#[test]
fn select_bid_happy_path_sets_winner_and_awarded_status() {
    let (mut svm, buyer) = fresh_svm();
    let (rfp, provider) = rfp_in_reveal(&mut svm, &buyer);

    assert!(select_bid(&mut svm, &buyer, rfp, provider.pubkey()));

    let state = read_rfp(&svm, rfp);
    assert_eq!(state.status, RfpStatus::Awarded);
    assert_eq!(state.winner, Some(provider.pubkey()));
}

#[test]
fn select_bid_rejected_before_reveal() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [10u8; 8]);
    let provider = fund(&mut svm);
    commit_bid(&mut svm, rfp, &provider, 1);
    // status is still Open, not Reveal
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Open);
    assert!(!select_bid(&mut svm, &buyer, rfp, provider.pubkey()));
    assert_eq!(read_rfp(&svm, rfp).winner, None);
}

#[test]
fn select_bid_rejected_for_non_buyer() {
    let (mut svm, buyer) = fresh_svm();
    let (rfp, provider) = rfp_in_reveal(&mut svm, &buyer);
    let intruder = fund(&mut svm);

    assert!(
        !select_bid(&mut svm, &intruder, rfp, provider.pubkey()),
        "non-buyer signer must not be able to select winner"
    );
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Reveal);
    assert_eq!(read_rfp(&svm, rfp).winner, None);
}

#[test]
fn select_bid_rejected_after_reveal_window_expires() {
    let (mut svm, buyer) = fresh_svm();
    let (rfp, provider) = rfp_in_reveal(&mut svm, &buyer);

    // jump past reveal_close_at
    set_clock(&mut svm, T0 + 86_400 * 3 + 1);
    assert!(
        !select_bid(&mut svm, &buyer, rfp, provider.pubkey()),
        "select must fail past reveal_close_at"
    );
    assert_eq!(read_rfp(&svm, rfp).status, RfpStatus::Reveal);
}

#[test]
fn select_bid_idempotent_blocked_by_status_check() {
    let (mut svm, buyer) = fresh_svm();
    let (rfp, provider) = rfp_in_reveal(&mut svm, &buyer);
    assert!(select_bid(&mut svm, &buyer, rfp, provider.pubkey()));
    // second select fails because status is now Awarded, not Reveal
    assert!(!select_bid(&mut svm, &buyer, rfp, provider.pubkey()));
}
