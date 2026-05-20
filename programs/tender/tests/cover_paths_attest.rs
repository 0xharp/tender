//! Attest cover-path tests — private_buyer_attest_path and
//! private_bidder_attest_path from the spec's `cover` declarations.
//!
//! Both paths model the "anonymous-now-claim-later" flow:
//!   * private_buyer_attest_path: buyer creates an RFP under an ephemeral
//!     wallet (BuyerVisibility::Private). After the RFP completes, the
//!     buyer's MAIN wallet runs attest_buyer_history to merge the
//!     stranded ephemeral BuyerReputation PDA into the main one.
//!   * private_bidder_attest_path: provider bids under a per-RFP bidder
//!     ephemeral (BidderVisibility::BuyerOnly). After completion, the
//!     provider's MAIN wallet runs attest_win to merge the eph's
//!     ProviderReputation into the main one + lock the one-shot
//!     AttestWinReceipt PDA.
//!
//! Both tests skip the PER segment (delegate_bid / write_bid_chunk /
//! finalize_bid) the same way `cover_happy_path_public_full` does — PER
//! needs the MagicBlock permission_program loaded into litesvm, which is
//! its own infrastructure piece. The attest end-state is reached via
//! commit_bid_init → close → select_bid → fund_project → start →
//! submit → accept, which is the post-PER sequence the program's real
//! production flow also takes once the bid is on-chain.

#![allow(dead_code, unused_imports)]

#[path = "spl_helpers.rs"]
mod helpers;

use anchor_lang::{InstructionData, ToAccountMetas};
use ed25519_dalek::SigningKey;
use helpers::*;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
    sysvar::instructions::ID as SYSVAR_INSTRUCTIONS_ID,
    transaction::Transaction,
};
use spl_associated_token_account::get_associated_token_address;
use tender::state::{BidderVisibility, BuyerVisibility, MilestoneStatus, PayoutChain, RfpStatus};

// ---- inline copies of helpers from cover_paths_extended.rs --------------
// Each tests/ file is its own crate, so we can't share `pub(crate)` helpers
// across them. spl_helpers.rs holds the shared SPL / Ed25519 primitives;
// these higher-level Anchor-ix builders are re-declared here.

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

fn create_rfp_with_visibility(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    nonce: [u8; 8],
    bidder_visibility: BidderVisibility,
    buyer_visibility: BuyerVisibility,
) -> Pubkey {
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce);
    let args = rfp_create_args(nonce, bidder_visibility, buyer_visibility);
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
    set_clock(svm, T0 + 1); // pin clock after rfp_create so commit_bid_init sees bid_open_at <= now
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

fn close_bidding_ix(svm: &mut litesvm::LiteSVM, payer: &Keypair, rfp: Pubkey) {
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::RfpCloseBidding {
            anyone: payer.pubkey(),
            rfp,
        }
        .to_account_metas(None),
        data: tender::instruction::RfpCloseBidding {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], blockhash);
    svm.send_transaction(tx).unwrap();
}

/// Public-mode select_bid (no bid-binding sigverify). Used for the
/// private_buyer path (where bidder is public — only buyer is private)
/// and for the bridge of private_bidder paths that we adapt below.
fn select_bid_public(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    bid: Pubkey,
    provider: Pubkey,
    contract_value: u64,
    milestone_amounts: Vec<u64>,
    milestone_durations_secs: Vec<i64>,
) {
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let args = tender::instructions::select_bid::SelectBidArgs {
        winner_provider: provider,
        contract_value,
        milestone_count: milestone_amounts.len() as u8,
        milestone_amounts,
        milestone_durations_secs,
    };
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::SelectBid {
            buyer: buyer.pubkey(),
            rfp,
            bid,
            buyer_reputation,
            provider_reputation,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::SelectBid { args }.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&buyer.pubkey()), &[buyer], blockhash);
    svm.send_transaction(tx).unwrap();
}

/// Private-bidder-mode select_bid: requires an Ed25519SigVerify ix at
/// index 0 proving `provider_eph` signed the canonical bid-binding
/// message. `winner_provider` is set to the ephemeral (not main wallet),
/// which is what makes downstream attest_win work.
fn select_bid_private_bidder(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    provider_eph_signing_key: &SigningKey,
    rfp: Pubkey,
    bid: Pubkey,
    provider_eph: Pubkey,
    main_wallet: Pubkey,
    contract_value: u64,
    milestone_amounts: Vec<u64>,
    milestone_durations_secs: Vec<i64>,
) {
    // Binding message proves: this main_wallet (provider) authorizes the
    // bid PDA on this RFP. attest_win will later re-verify the same
    // signature shape.
    let msg = build_bid_binding_message(&rfp, &bid, &main_wallet);
    let sigverify_ix = build_ed25519_sigverify_ix(provider_eph_signing_key, &msg);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let (provider_reputation, _) = provider_rep_pda(&provider_eph);
    let args = tender::instructions::select_bid::SelectBidArgs {
        winner_provider: provider_eph,
        contract_value,
        milestone_count: milestone_amounts.len() as u8,
        milestone_amounts,
        milestone_durations_secs,
    };
    let select_ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::SelectBid {
            buyer: buyer.pubkey(),
            rfp,
            bid,
            buyer_reputation,
            provider_reputation,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::SelectBid { args }.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, select_ix],
        Some(&buyer.pubkey()),
        &[buyer],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

fn fund_project_ix(
    svm: &mut litesvm::LiteSVM,
    funder: &Keypair,
    buyer: &Keypair,
    buyer_signing_key: &SigningKey,
    rfp: Pubkey,
    mint: Pubkey,
    contract_value: u64,
    milestone_count: u8,
) {
    let funder_ata = get_associated_token_address(&funder.pubkey(), &mint);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());

    let msg = build_fund_auth_message(&rfp, contract_value);
    let sigverify_ix = build_ed25519_sigverify_ix(buyer_signing_key, &msg);

    let mut accounts = tender::accounts::FundProject {
        funder: funder.pubkey(),
        buyer: buyer.pubkey(),
        rfp,
        escrow,
        mint,
        funder_ata,
        escrow_ata,
        buyer_reputation,
        instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
        token_program: spl_token::ID,
        associated_token_program: spl_associated_token_account::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);

    for i in 0..milestone_count {
        let (ms, _) = milestone_pda(&rfp, i);
        accounts.push(solana_sdk::instruction::AccountMeta::new(ms, false));
    }

    let ix = Instruction {
        program_id: tender::ID,
        accounts,
        data: tender::instruction::FundProject {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, ix],
        Some(&funder.pubkey()),
        &[funder],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

fn start_milestone_ix(svm: &mut litesvm::LiteSVM, provider: &Keypair, rfp: Pubkey, idx: u8) {
    let (milestone, _) = milestone_pda(&rfp, idx);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::StartMilestone {
            provider: provider.pubkey(),
            rfp,
            milestone,
        }
        .to_account_metas(None),
        data: tender::instruction::StartMilestone {
            milestone_index: idx,
        }
        .data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx =
        Transaction::new_signed_with_payer(&[ix], Some(&provider.pubkey()), &[provider], blockhash);
    svm.send_transaction(tx).unwrap();
}

fn submit_milestone_ix(svm: &mut litesvm::LiteSVM, provider: &Keypair, rfp: Pubkey, idx: u8) {
    let (milestone, _) = milestone_pda(&rfp, idx);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::SubmitMilestone {
            provider: provider.pubkey(),
            rfp,
            milestone,
        }
        .to_account_metas(None),
        data: tender::instruction::SubmitMilestone {
            milestone_index: idx,
        }
        .data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx =
        Transaction::new_signed_with_payer(&[ix], Some(&provider.pubkey()), &[provider], blockhash);
    svm.send_transaction(tx).unwrap();
}

fn accept_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    provider: Pubkey,
    idx: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, idx);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let provider_ata = get_associated_token_address(&provider, &mint);
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, &mint);
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AcceptMilestone {
            buyer: buyer.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            provider_ata,
            treasury,
            treasury_ata,
            provider_reputation,
            buyer_reputation,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::AcceptMilestone {
            milestone_index: idx,
        }
        .data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&buyer.pubkey()), &[buyer], blockhash);
    svm.send_transaction(tx).unwrap();
}

// ---- attest_buyer_history helper (new) ----------------------------------

fn attest_buyer_history_ix(
    svm: &mut litesvm::LiteSVM,
    main_wallet: &Keypair,
    main_signing_key: &SigningKey,
    rfp: Pubkey,
    buyer_eph: Pubkey,
) {
    let msg = build_buyer_eph_binding_message(&rfp, &main_wallet.pubkey(), &buyer_eph);
    let sigverify_ix = build_ed25519_sigverify_ix(main_signing_key, &msg);

    let (ephemeral_rep, _) = buyer_rep_pda(&buyer_eph);
    let (main_rep, _) = buyer_rep_pda(&main_wallet.pubkey());

    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AttestBuyerHistory {
            main_wallet: main_wallet.pubkey(),
            rfp,
            ephemeral_rep,
            main_rep,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::AttestBuyerHistory {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, ix],
        Some(&main_wallet.pubkey()),
        &[main_wallet],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

// ---- attest_win helper (new) --------------------------------------------

fn attest_win_ix(
    svm: &mut litesvm::LiteSVM,
    main_wallet: &Keypair,
    main_signing_key: &SigningKey,
    bid: Pubkey,
    rfp: Pubkey,
    provider_eph: Pubkey,
) {
    let msg = build_bid_binding_message(&rfp, &bid, &main_wallet.pubkey());
    let sigverify_ix = build_ed25519_sigverify_ix(main_signing_key, &msg);

    let (ephemeral_rep, _) = provider_rep_pda(&provider_eph);
    let (main_rep, _) = provider_rep_pda(&main_wallet.pubkey());
    let (claim_receipt, _) = attest_win_receipt_pda(&bid);

    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AttestWin {
            main_wallet: main_wallet.pubkey(),
            bid,
            rfp,
            ephemeral_rep,
            main_rep,
            claim_receipt,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::AttestWin {}.data(),
    };
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, ix],
        Some(&main_wallet.pubkey()),
        &[main_wallet],
        blockhash,
    );
    svm.send_transaction(tx).unwrap();
}

// ====================================================================
// TEST: cover_private_buyer_attest_path
// ====================================================================
//
// Spec sequence: rfp_create → commit_bid_init → (PER segment skipped) →
// rfp_close_bidding → open_reveal_window (skipped — not strictly needed
// for public bidder) → select_bid → fund_project → start_milestone →
// submit_milestone → accept_milestone → attest_buyer_history
//
// Setup: BUYER_EPH (ephemeral) signs the RFP creation + select_bid +
// fund_project + accept_milestone. After completion, MAIN_WALLET (a
// different keypair) runs attest_buyer_history to claim the stranded
// BuyerReputation PDA at [BUYER_REP_SEED, BUYER_EPH.pubkey].
//
// What this proves: a buyer can run an RFP fully anonymously under an
// ephemeral wallet, then later voluntarily bind it to their main wallet
// for reputation credit via a one-shot Ed25519-authenticated attestation.
#[test]
fn cover_private_buyer_attest_path() {
    let (mut svm, payer) = fresh_svm_with_token();

    // BUYER_EPH plays the role of the buyer throughout the RFP lifecycle.
    let buyer_eph = Keypair::new();
    svm.airdrop(&buyer_eph.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 10 * ONE_SOL).unwrap();

    // MAIN_WALLET is a DIFFERENT keypair the buyer will later use to claim.
    let main_wallet = Keypair::new();
    svm.airdrop(&main_wallet.pubkey(), 10 * ONE_SOL).unwrap();

    let buyer_eph_signing_key = signing_key_from_solana_keypair(&buyer_eph);
    let main_signing_key = signing_key_from_solana_keypair(&main_wallet);

    // USDC + ATAs + treasury (same shape as happy_path).
    let (mint, mint_authority) = create_mint(&mut svm, &payer, 6);
    let mint_pk = mint.pubkey();
    let funder_ata = create_ata(&mut svm, &payer, &funder.pubkey(), &mint_pk);
    let _ = create_ata(&mut svm, &payer, &provider.pubkey(), &mint_pk);
    let contract_value: u64 = 1_000_000_000;
    mint_to(
        &mut svm,
        &mint_authority,
        &mint_pk,
        &funder_ata,
        contract_value * 2,
    );
    let _treasury = init_treasury(&mut svm, &payer, &mint_pk, payer.pubkey());

    // ---- RFP under BUYER_EPH, with BuyerVisibility::Private + PUBLIC bidder ----
    let nonce = *b"prvbuy01";
    let rfp = create_rfp_with_visibility(
        &mut svm,
        &buyer_eph,
        nonce,
        BidderVisibility::Public,
        BuyerVisibility::Private,
    );
    let r0 = fetch_rfp(&svm, &rfp);
    assert!(matches!(r0.buyer_visibility, BuyerVisibility::Private));
    assert_eq!(r0.buyer, buyer_eph.pubkey(), "rfp.buyer is the ephemeral");
    assert!(!r0.buyer_attested);

    // ---- bid + close + select + fund + milestones (single-milestone) ----
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint_pk);
    set_clock(&mut svm, r0.bid_close_at + 1);
    close_bidding_ix(&mut svm, &payer, rfp);
    select_bid_public(
        &mut svm,
        &buyer_eph,
        rfp,
        bid,
        provider.pubkey(),
        contract_value,
        vec![contract_value],
        vec![86_400],
    );
    fund_project_ix(
        &mut svm,
        &funder,
        &buyer_eph,
        &buyer_eph_signing_key,
        rfp,
        mint_pk,
        contract_value,
        1,
    );
    start_milestone_ix(&mut svm, &provider, rfp, 0);
    submit_milestone_ix(&mut svm, &provider, rfp, 0);
    accept_milestone_ix(
        &mut svm,
        &buyer_eph,
        rfp,
        mint_pk,
        provider.pubkey(),
        0,
    );

    // ---- After accept_milestone with milestone_count=1, RFP is Completed ----
    let r_done = fetch_rfp(&svm, &rfp);
    assert!(
        matches!(r_done.status, RfpStatus::Completed),
        "expected Completed, got {:?}",
        r_done.status
    );
    assert!(!r_done.buyer_attested, "not yet attested");

    // ---- Stranded eph rep before attest ----
    let eph_rep_before = fetch_buyer_rep(&svm, &buyer_eph.pubkey());
    assert!(
        eph_rep_before.completed_rfps >= 1,
        "ephemeral accumulated at least one completed RFP"
    );

    // ---- attest_buyer_history: MAIN signs binding ↔ BUYER_EPH ----
    attest_buyer_history_ix(
        &mut svm,
        &main_wallet,
        &main_signing_key,
        rfp,
        buyer_eph.pubkey(),
    );

    // ---- Post-state checks ----
    let r_attested = fetch_rfp(&svm, &rfp);
    assert!(r_attested.buyer_attested, "rfp marks attestation");
    let main_rep_after = fetch_buyer_rep(&svm, &main_wallet.pubkey());
    assert!(
        main_rep_after.completed_rfps >= 1,
        "main wallet inherited completed_rfps from ephemeral"
    );

    // ---- Idempotency: second attest must reject ----
    let blockhash = svm.latest_blockhash();
    let msg = build_buyer_eph_binding_message(&rfp, &main_wallet.pubkey(), &buyer_eph.pubkey());
    let sigverify_ix = build_ed25519_sigverify_ix(&main_signing_key, &msg);
    let (ephemeral_rep, _) = buyer_rep_pda(&buyer_eph.pubkey());
    let (main_rep, _) = buyer_rep_pda(&main_wallet.pubkey());
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AttestBuyerHistory {
            main_wallet: main_wallet.pubkey(),
            rfp,
            ephemeral_rep,
            main_rep,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::AttestBuyerHistory {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, ix],
        Some(&main_wallet.pubkey()),
        &[&main_wallet],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(result.is_err(), "second attest_buyer_history must reject");
}

// ====================================================================
// TEST: cover_private_bidder_attest_path
// ====================================================================
//
// Spec sequence: rfp_create → commit_bid_init → (PER segment skipped) →
// rfp_close_bidding → open_reveal_window (skipped) → select_bid (with
// Ed25519 bid-binding sig from provider_eph) → fund_project →
// start_milestone → submit_milestone → accept_milestone → attest_win
//
// Setup: BUYER is regular (public). PROVIDER_EPH (ephemeral bidder)
// signs the bid + provides the bid-binding sig at select_bid time.
// After completion, MAIN_WALLET (provider's main wallet) runs attest_win
// to claim the stranded ProviderReputation PDA.
//
// What this proves: a provider can bid anonymously under a per-RFP
// bidder ephemeral, then later bind the won bid to their main wallet
// for public reputation credit via a one-shot Ed25519-authenticated
// attestation, locked by the AttestWinReceipt PDA.
#[test]
fn cover_private_bidder_attest_path() {
    let (mut svm, payer) = fresh_svm_with_token();

    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider_eph = Keypair::new();
    svm.airdrop(&provider_eph.pubkey(), 10 * ONE_SOL).unwrap();
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 10 * ONE_SOL).unwrap();
    let main_wallet = Keypair::new();
    svm.airdrop(&main_wallet.pubkey(), 10 * ONE_SOL).unwrap();

    let buyer_signing_key = signing_key_from_solana_keypair(&buyer);
    let provider_eph_signing_key = signing_key_from_solana_keypair(&provider_eph);
    let main_signing_key = signing_key_from_solana_keypair(&main_wallet);

    let (mint, mint_authority) = create_mint(&mut svm, &payer, 6);
    let mint_pk = mint.pubkey();
    let funder_ata = create_ata(&mut svm, &payer, &funder.pubkey(), &mint_pk);
    let _ = create_ata(&mut svm, &payer, &provider_eph.pubkey(), &mint_pk);
    let contract_value: u64 = 1_000_000_000;
    mint_to(
        &mut svm,
        &mint_authority,
        &mint_pk,
        &funder_ata,
        contract_value * 2,
    );
    let _treasury = init_treasury(&mut svm, &payer, &mint_pk, payer.pubkey());

    // ---- RFP with BidderVisibility::BuyerOnly (private bidder mode) ----
    let nonce = *b"prvbid01";
    let rfp = create_rfp_with_visibility(
        &mut svm,
        &buyer,
        nonce,
        BidderVisibility::BuyerOnly,
        BuyerVisibility::Public,
    );
    let r0 = fetch_rfp(&svm, &rfp);
    assert!(matches!(r0.bidder_visibility, BidderVisibility::BuyerOnly));

    // ---- bid + close + private-bidder select ----
    let bid = commit_bid_init_for(&mut svm, rfp, &provider_eph, mint_pk);
    set_clock(&mut svm, r0.bid_close_at + 1);
    close_bidding_ix(&mut svm, &payer, rfp);
    select_bid_private_bidder(
        &mut svm,
        &buyer,
        &provider_eph_signing_key,
        rfp,
        bid,
        provider_eph.pubkey(),
        main_wallet.pubkey(),
        contract_value,
        vec![contract_value],
        vec![86_400],
    );
    let r_sel = fetch_rfp(&svm, &rfp);
    assert!(matches!(r_sel.status, RfpStatus::Awarded));
    assert_eq!(
        r_sel.winner_provider,
        Some(provider_eph.pubkey()),
        "winner_provider is the ephemeral, not main"
    );

    // ---- fund + milestone cycle (provider_eph collects payouts) ----
    fund_project_ix(
        &mut svm,
        &funder,
        &buyer,
        &buyer_signing_key,
        rfp,
        mint_pk,
        contract_value,
        1,
    );
    start_milestone_ix(&mut svm, &provider_eph, rfp, 0);
    submit_milestone_ix(&mut svm, &provider_eph, rfp, 0);
    accept_milestone_ix(
        &mut svm,
        &buyer,
        rfp,
        mint_pk,
        provider_eph.pubkey(),
        0,
    );

    let r_done = fetch_rfp(&svm, &rfp);
    assert!(
        matches!(r_done.status, RfpStatus::Completed),
        "expected Completed, got {:?}",
        r_done.status
    );

    // Stranded provider rep on ephemeral
    let eph_prep = fetch_provider_rep(&svm, &provider_eph.pubkey());
    assert!(
        eph_prep.completed_projects >= 1,
        "ephemeral has completed project"
    );

    // ---- attest_win: MAIN_WALLET binds ↔ bid PDA via Ed25519 sig ----
    attest_win_ix(
        &mut svm,
        &main_wallet,
        &main_signing_key,
        bid,
        rfp,
        provider_eph.pubkey(),
    );

    // ---- Post-state: main wallet has the rep + claim_receipt PDA exists ----
    let main_prep_after = fetch_provider_rep(&svm, &main_wallet.pubkey());
    assert!(
        main_prep_after.completed_projects >= 1,
        "main wallet inherited completed_projects from ephemeral"
    );

    let (claim_receipt, _) = attest_win_receipt_pda(&bid);
    let claim_acc = svm
        .get_account(&claim_receipt)
        .expect("claim_receipt PDA exists");
    assert!(
        !claim_acc.data.is_empty(),
        "claim_receipt has been initialized"
    );

    // ---- Idempotency: second attest_win on same bid must reject (init not init_if_needed) ----
    let blockhash = svm.latest_blockhash();
    let msg = build_bid_binding_message(&rfp, &bid, &main_wallet.pubkey());
    let sigverify_ix = build_ed25519_sigverify_ix(&main_signing_key, &msg);
    let (ephemeral_rep, _) = provider_rep_pda(&provider_eph.pubkey());
    let (main_rep, _) = provider_rep_pda(&main_wallet.pubkey());
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AttestWin {
            main_wallet: main_wallet.pubkey(),
            bid,
            rfp,
            ephemeral_rep,
            main_rep,
            claim_receipt,
            instructions_sysvar: SYSVAR_INSTRUCTIONS_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::AttestWin {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, ix],
        Some(&main_wallet.pubkey()),
        &[&main_wallet],
        blockhash,
    );
    let result = svm.send_transaction(tx);
    assert!(
        result.is_err(),
        "second attest_win on same bid must reject (claim_receipt already exists)"
    );
}
