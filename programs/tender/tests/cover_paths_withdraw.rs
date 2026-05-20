//! cover_withdraw_path — spec sequence: rfp_create → commit_bid_init →
//! delegate_bid → write_bid_chunk → finalize_bid → withdraw_bid →
//! close_withdrawn_bid.
//!
//! ## Why the happy-path test is `#[ignore]`
//!
//! withdraw_bid does THREE CPIs into MagicBlock's ephemeral-rollups
//! programs:
//!   1. `CommitAndUndelegatePermissionCpiBuilder.invoke_signed(...)` →
//!      `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`
//!      (PERMISSION_PROGRAM_ID — releases the bid's delegation)
//!   2. `MagicIntentBundleBuilder.build_and_invoke()` →
//!      `Magic11111111111111111111111111111111111111`
//!      (MAGIC_PROGRAM_ID — propagates the state change back to L1)
//!   3. Reads/writes the `MagicContext1111111111111111111111111111111`
//!      magic_context account.
//!
//! The PERMISSION_PROGRAM (ACLseo...) is deployed to devnet (we have its
//! `.so` at `target/deploy/permission_program.so` — fetched via
//! `solana program dump`). But MAGIC_PROGRAM (Magic11...) is an ER-only
//! virtual program: it's NOT deployed on devnet OR mainnet base-layer
//! Solana. `solana program dump` returns "Unable to find the account" on
//! both networks. The MagicBlock validator running on the ephemeral
//! rollup is the only place that program exists; the CPI is a no-op
//! handled at the validator layer when executed inside the ER.
//!
//! This means withdraw_bid is architecturally untestable in litesvm
//! end-to-end. Three viable paths forward:
//!   (a) Devnet/MagicBlock-ER integration test: send the full tx against
//!       https://devnet.magicblock.app and observe state. Test infra
//!       lives outside `cargo test`.
//!   (b) Run against the open-source MagicBlock ephemeral-validator (if
//!       available) — adds an extra subprocess to the test rig.
//!   (c) Mock MAGIC_PROGRAM: write a no-op program with the same program
//!       ID that satisfies the CPI signature. Only valid if we're
//!       testing the on-chain part of withdraw_bid (the state change
//!       before the CPIs), not the propagation itself.
//!
//! ## What we CAN test in litesvm
//!
//! The require!() checks in withdraw_bid that run BEFORE the CPIs are
//! testable in litesvm — they exercise the on-chain state-machine logic
//! we actually own. Below: two rejection tests for the guard layer.
//! Happy-path remains `#[ignore]`'d with full documentation above.

#![allow(dead_code, unused_imports)]

#[path = "spl_helpers.rs"]
mod helpers;

use anchor_lang::{InstructionData, ToAccountMetas};
use helpers::*;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    transaction::Transaction,
};
use spl_associated_token_account::get_associated_token_address;
use tender::state::{BidderVisibility, BuyerVisibility, PayoutChain};

// PERMISSION_PROGRAM_ID — needed for accounts struct even on rejection paths
// because the program checks the address before reaching the require!s.
const PERMISSION_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

// MagicBlock ephemeral-rollup program IDs — `#[commit]` macro on the
// WithdrawBid accounts struct injects these fields. We pass them by
// pubkey for the rejection tests (the program is never invoked because
// the require!s reject before any CPI).
const MAGIC_PROGRAM_ID: Pubkey =
    Pubkey::from_str_const("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID: Pubkey =
    Pubkey::from_str_const("MagicContext1111111111111111111111111111111");

const PERMISSION_SEED: &[u8] = b"permission";

fn permission_pda(bid: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PERMISSION_SEED, bid.as_ref()], &PERMISSION_PROGRAM_ID)
}

fn build_withdraw_bid_ix(provider: Pubkey, bid: Pubkey) -> Instruction {
    let (permission, _) = permission_pda(&bid);
    Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::WithdrawBid {
            provider,
            bid,
            permission,
            permission_program: PERMISSION_PROGRAM_ID,
            magic_context: MAGIC_CONTEXT_ID,
            magic_program: MAGIC_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: tender::instruction::WithdrawBid {}.data(),
    }
}

// ---- Inline copies of higher-level helpers from cover_paths_extended ----

fn rfp_create_args(
    nonce: [u8; 8],
    bidder_visibility: BidderVisibility,
    buyer_visibility: BuyerVisibility,
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
        buyer_visibility,
        reserve_price_commitment: [0u8; 32],
        funding_window_secs: 0,
        review_window_secs: 0,
        dispute_cooloff_secs: 0,
        cancel_notice_secs: 0,
        max_iterations: 0,
    }
}

fn create_rfp_public(svm: &mut litesvm::LiteSVM, buyer: &Keypair, nonce: [u8; 8]) -> Pubkey {
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce);
    let args = rfp_create_args(
        nonce,
        BidderVisibility::Public,
        BuyerVisibility::Public,
    );
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
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&buyer.pubkey()), &[buyer], blockhash);
    svm.send_transaction(tx).unwrap();
    set_clock(svm, T0 + 1);
    rfp
}

fn commit_bid_init_for(
    svm: &mut litesvm::LiteSVM,
    rfp: Pubkey,
    provider: &Keypair,
    mint: Pubkey,
) -> Pubkey {
    let (bid, _) = bid_pda(&rfp, &provider.pubkey());
    let provider_ata = get_associated_token_address(&provider.pubkey(), &mint);
    let args = tender::instructions::commit_bid_init::CommitBidInitArgs {
        commit_hash: [3u8; 32],
        buyer_envelope_len: 1024,
        provider_envelope_len: 1024,
        payout_chain: PayoutChain::Solana { mint },
        payout_destination: provider_ata,
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
    let blockhash = svm.latest_blockhash();
    let tx =
        Transaction::new_signed_with_payer(&[ix], Some(&provider.pubkey()), &[provider], blockhash);
    svm.send_transaction(tx).unwrap();
    bid
}

// ====================================================================
// TEST 1 (happy path): #[ignore] because MAGIC_PROGRAM is ER-only.
// ====================================================================

#[test]
#[ignore = "MAGIC_PROGRAM is ER-only — see file-level docs for the three viable paths forward"]
fn cover_withdraw_path_full() {
    // Intentionally not implemented. See file header for the architectural
    // reason this test can't run in litesvm and the three options
    // (devnet integration / ephemeral-validator subprocess / mock).
}

// ====================================================================
// TEST 2 (guard layer): withdraw_bid by a non-provider must reject.
// ====================================================================
// Tests the pre-CPI `require_keys_eq!(provider.key(), bid.provider, ...)`
// guard. This guard runs BEFORE any MagicBlock CPI, so litesvm CAN reach
// the rejection without needing MAGIC_PROGRAM.

#[test]
fn withdraw_bid_rejects_wrong_provider() {
    let (mut svm, payer) = fresh_svm_with_token();

    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();
    let attacker = Keypair::new();
    svm.airdrop(&attacker.pubkey(), 10 * ONE_SOL).unwrap();

    let (mint, _ma) = create_mint(&mut svm, &payer, 6);
    let mint_pk = mint.pubkey();
    let _ = create_ata(&mut svm, &payer, &provider.pubkey(), &mint_pk);
    let _treasury = init_treasury(&mut svm, &payer, &mint_pk, payer.pubkey());

    let rfp = create_rfp_public(&mut svm, &buyer, *b"wdrgrd01");
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint_pk);

    // Attacker (not the bid's provider) attempts to withdraw.
    let ix = build_withdraw_bid_ix(attacker.pubkey(), bid);
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&attacker.pubkey()),
        &[&attacker],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(
        result.is_err(),
        "withdraw_bid by non-provider must reject (NotProvider guard)"
    );
}

// ====================================================================
// TEST 3 (guard layer): withdraw_bid after bid window close must reject.
// ====================================================================
// Tests the pre-CPI `require!(now < bid.bid_close_at, BidWindowClosed)`
// guard. Runs before any MagicBlock CPI.

#[test]
fn withdraw_bid_rejects_after_window_close() {
    let (mut svm, payer) = fresh_svm_with_token();

    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();

    let (mint, _ma) = create_mint(&mut svm, &payer, 6);
    let mint_pk = mint.pubkey();
    let _ = create_ata(&mut svm, &payer, &provider.pubkey(), &mint_pk);
    let _treasury = init_treasury(&mut svm, &payer, &mint_pk, payer.pubkey());

    let rfp = create_rfp_public(&mut svm, &buyer, *b"wdrgrd02");
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint_pk);

    // Advance clock past the bid close.
    let r = fetch_rfp(&svm, &rfp);
    set_clock(&mut svm, r.bid_close_at + 1);

    let ix = build_withdraw_bid_ix(provider.pubkey(), bid);
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[&provider],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(
        result.is_err(),
        "withdraw_bid after bid_close_at must reject (BidWindowClosed)"
    );
}
