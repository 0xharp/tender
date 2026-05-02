//! Rust LiteSVM tests for low-level state transitions + arithmetic invariants.
//!
//! Coverage focus per agreed split (Day 6 update):
//!   - rfp_create with both `bidder_visibility` modes (L0 Public / L1 BuyerOnly)
//!   - state machine (Open → Reveal, no double-close, permissionless signer)
//!   - bid_count saturating_add via commit_bid_init
//!   - PDA bump derivation stored on-account matches Pubkey::find_program_address
//!   - L0 enforcement: bid_pda_seed must equal provider wallet bytes
//!   - ProviderIdentity binding correct per mode
//!
//! Day 6 removed: withdraw_bid + select_bid tests moved to TS LiteSVM (and
//! eventually live devnet) because they now require PER permission accounts +
//! Magic Action runtime that LiteSVM 0.7 + ephemeral-rollups-sdk 0.11 don't
//! simulate. We test those flows end-to-end against the real ER on devnet
//! during Phase G.

use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use tender::state::{BidCommit, BidStatus, BidderVisibility, Rfp, RfpStatus};

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

fn bid_pda(rfp: &Pubkey, seed: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"bid", rfp.as_ref(), seed.as_ref()], &tender::ID)
}

fn default_rfp_args(
    nonce: [u8; 8],
    bidder_visibility: BidderVisibility,
) -> tender::instructions::rfp_create::RfpCreateArgs {
    tender::instructions::rfp_create::RfpCreateArgs {
        rfp_nonce: nonce,
        buyer_encryption_pubkey: [1u8; 32],
        title_hash: [2u8; 32],
        category: 0,
        bid_open_at: T0,
        bid_close_at: T0 + 86_400,
        reveal_close_at: T0 + 86_400 * 3,
        bidder_visibility,
        reserve_price_commitment: [0u8; 32],
        funding_window_secs: 0,
        review_window_secs: 0,
        dispute_cooloff_secs: 0,
        cancel_notice_secs: 0,
        max_iterations: 0,
    }
}

fn create_rfp(svm: &mut LiteSVM, buyer: &Keypair, nonce: [u8; 8]) -> Pubkey {
    create_rfp_with(svm, buyer, nonce, BidderVisibility::Public)
}

fn create_rfp_with(
    svm: &mut LiteSVM,
    buyer: &Keypair,
    nonce: [u8; 8],
    bidder_visibility: BidderVisibility,
) -> Pubkey {
    let (rfp, _bump) = rfp_pda(&buyer.pubkey(), &nonce);
    let args = default_rfp_args(nonce, bidder_visibility);
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

/// Build a `commit_bid_init` ix and submit it. Used to verify init-side state
/// changes; the subsequent delegate_bid + chunk writes + finalize aren't
/// runnable here (need PER) and are covered by the Phase G devnet test.
fn commit_bid_init(
    svm: &mut LiteSVM,
    rfp: Pubkey,
    provider: &Keypair,
    _seed: [u8; 32],   // legacy param - bid PDA now derives from provider.pubkey directly
    buyer_envelope_len: u32,
    provider_envelope_len: u32,
    commit_hash: [u8; 32],
) -> std::result::Result<Pubkey, ()> {
    let (bid, _) = bid_pda(&rfp, &provider.pubkey().to_bytes());
    let args = tender::instructions::commit_bid_init::CommitBidInitArgs {
        commit_hash,
        buyer_envelope_len,
        provider_envelope_len,
        payout_destination: provider.pubkey(),
        payout_chain: tender::state::PayoutChain::Solana {
            mint: anchor_spl::token::spl_token::native_mint::id(),
        },
    };
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::CommitBidInit {
            provider: provider.pubkey(),
            rfp,
            bid,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::CommitBidInit { args }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[provider],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).map(|_| bid).map_err(|_| ())
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

fn read_bid(svm: &LiteSVM, bid: Pubkey) -> BidCommit {
    let account = svm.get_account(&bid).expect("bid account should exist");
    BidCommit::try_deserialize(&mut account.data.as_ref()).expect("bid should deserialize")
}

fn fund(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 10 * ONE_SOL).unwrap();
    kp
}

fn sha256(input: &[u8]) -> [u8; 32] {
    use solana_sha256_hasher::hashv;
    hashv(&[input]).to_bytes()
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
    assert_eq!(state.bidder_visibility, BidderVisibility::Public);
}

#[test]
fn rfp_create_initializes_optional_fields_correctly() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    let state = read_rfp(&svm, rfp);
    assert_eq!(state.winner, None, "winner must start as None");
    assert_eq!(state.contract_value, 0, "contract_value set at fund time");
    assert_eq!(state.created_at, T0);
}

#[test]
fn rfp_create_with_buyer_only_visibility() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp_with(&mut svm, &buyer, [7u8; 8], BidderVisibility::BuyerOnly);
    assert_eq!(read_rfp(&svm, rfp).bidder_visibility, BidderVisibility::BuyerOnly);
}

// -----------------------------------------------------------------------------
// commit_bid_init: bid_count, identity binding, PDA seed validation
// -----------------------------------------------------------------------------

#[test]
fn commit_bid_init_increments_bid_count_l0() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    assert_eq!(read_rfp(&svm, rfp).bid_count, 0);

    let p1 = fund(&mut svm);
    commit_bid_init(&mut svm, rfp, &p1, p1.pubkey().to_bytes(), 100, 100, [1u8; 32])
        .expect("init should succeed");
    assert_eq!(read_rfp(&svm, rfp).bid_count, 1);

    let p2 = fund(&mut svm);
    commit_bid_init(&mut svm, rfp, &p2, p2.pubkey().to_bytes(), 100, 100, [2u8; 32])
        .expect("init should succeed");
    assert_eq!(read_rfp(&svm, rfp).bid_count, 2);
}

#[test]
fn commit_bid_init_l0_stores_plain_identity() {
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp(&mut svm, &buyer, [1u8; 8]);
    let p = fund(&mut svm);
    let bid = commit_bid_init(&mut svm, rfp, &p, p.pubkey().to_bytes(), 100, 100, [9u8; 32])
        .expect("init should succeed");

    let state = read_bid(&svm, bid);
    assert_eq!(state.status, BidStatus::Initializing);
    assert_eq!(state.commit_hash, [9u8; 32]);
    assert_eq!(state.buyer, buyer.pubkey());
    assert_eq!(state.bid_close_at, T0 + 86_400);
    assert_eq!(state.provider, p.pubkey(), "bid.provider == signer pubkey");
}

#[test]
fn commit_bid_init_buyer_only_mode_uses_signer_as_provider_too() {
    // After the simplification, both modes store `provider = signer.pubkey`.
    // The privacy in BuyerOnly mode comes from the client using an ephemeral
    // wallet to sign - the program doesn't enforce or even know.
    let (mut svm, buyer) = fresh_svm();
    let rfp = create_rfp_with(&mut svm, &buyer, [1u8; 8], BidderVisibility::BuyerOnly);
    let p = fund(&mut svm);
    let bid = commit_bid_init(&mut svm, rfp, &p, p.pubkey().to_bytes(), 100, 100, [4u8; 32])
        .expect("BuyerOnly init should succeed");
    let state = read_bid(&svm, bid);
    assert_eq!(state.provider, p.pubkey());
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
// rfp_create input validation (no PER required)
// -----------------------------------------------------------------------------

#[test]
fn rfp_create_rejects_inverted_bid_window() {
    // bid_close_at <= bid_open_at must trip InvalidBidWindow (6023). Catches
    // a class of UX bugs where the buyer's clock is wrong or the form skips
    // its zod check.
    let (mut svm, buyer) = fresh_svm();
    let nonce = [9u8; 8];
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce);
    let mut args = default_rfp_args(nonce, BidderVisibility::Public);
    args.bid_close_at = args.bid_open_at; // invalid: not strictly greater
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
        &[&buyer],
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(tx).is_err(), "inverted window must be rejected");
}

#[test]
fn rfp_create_persists_reserve_commitment() {
    // Foundation for reveal_reserve: a non-zero commitment must be stored
    // verbatim on the account so reveal_reserve can hash + compare later.
    let (mut svm, buyer) = fresh_svm();
    let nonce = [10u8; 8];
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce);
    let mut args = default_rfp_args(nonce, BidderVisibility::Public);
    let commitment = [0xABu8; 32];
    args.reserve_price_commitment = commitment;
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
        &[&buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("rfp_create with reserve must succeed");
    let stored = read_rfp(&svm, rfp);
    assert_eq!(stored.reserve_price_commitment, commitment);
    assert_eq!(stored.reserve_price_revealed, 0, "reveal must start at 0");
}

// -----------------------------------------------------------------------------
// reveal_reserve happy path + commitment-mismatch rejection
// -----------------------------------------------------------------------------

fn reveal_reserve(
    svm: &mut LiteSVM,
    rfp: Pubkey,
    buyer: &Keypair,
    amount: u64,
    nonce: [u8; 32],
) -> std::result::Result<(), ()> {
    let args = tender::instructions::reveal_reserve::RevealReserveArgs {
        reserve_amount: amount,
        reserve_nonce: nonce,
    };
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::RevealReserve {
            buyer: buyer.pubkey(),
            rfp,
        }
        .to_account_metas(None),
        data: tender::instruction::RevealReserve { args }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).map(|_| ()).map_err(|_| ())
}

fn create_rfp_with_reserve(
    svm: &mut LiteSVM,
    buyer: &Keypair,
    nonce_seed: [u8; 8],
    reserve_amount: u64,
    reserve_nonce: [u8; 32],
) -> Pubkey {
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce_seed);
    let mut args = default_rfp_args(nonce_seed, BidderVisibility::Public);
    // Recompute the same commitment hash the client builds:
    //   SHA256(amount_le(8) || nonce(32))
    let mut buf = [0u8; 8 + 32];
    buf[..8].copy_from_slice(&reserve_amount.to_le_bytes());
    buf[8..].copy_from_slice(&reserve_nonce);
    args.reserve_price_commitment = sha256(&buf);
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
    svm.send_transaction(tx).expect("rfp_create with reserve must succeed");
    rfp
}

#[test]
fn reveal_reserve_happy_path() {
    // Buyer commits a reserve, closes bidding (status -> Reveal), then reveals
    // with the correct (amount, nonce). The on-chain hash check accepts and
    // `reserve_price_revealed` reflects the value, enabling select_bid to
    // enforce `winning_bid <= reserve` later.
    let (mut svm, buyer) = fresh_svm();
    let amount: u64 = 500_000_000; // $500 USDC base units
    let nonce = [0x42u8; 32];
    let rfp = create_rfp_with_reserve(&mut svm, &buyer, [11u8; 8], amount, nonce);
    set_clock(&mut svm, T0 + 86_400 + 1);
    assert!(close_bidding(&mut svm, rfp, &buyer));
    assert!(reveal_reserve(&mut svm, rfp, &buyer, amount, nonce).is_ok());
    let r = read_rfp(&svm, rfp);
    assert_eq!(r.reserve_price_revealed, amount);
}

#[test]
fn reveal_reserve_rejects_wrong_amount() {
    // Wrong amount -> commitment hash mismatch -> ReserveCommitmentMismatch.
    // Guards against a buyer trying to "lower" the reserve at reveal time
    // to accept a higher bid than they committed to.
    let (mut svm, buyer) = fresh_svm();
    let amount: u64 = 1_000_000_000;
    let nonce = [0x77u8; 32];
    let rfp = create_rfp_with_reserve(&mut svm, &buyer, [12u8; 8], amount, nonce);
    set_clock(&mut svm, T0 + 86_400 + 1);
    assert!(close_bidding(&mut svm, rfp, &buyer));
    assert!(
        reveal_reserve(&mut svm, rfp, &buyer, amount + 1, nonce).is_err(),
        "wrong amount must be rejected"
    );
    // And the on-chain reserve_price_revealed must stay 0 - no partial state.
    assert_eq!(read_rfp(&svm, rfp).reserve_price_revealed, 0);
}
