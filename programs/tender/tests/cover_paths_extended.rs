//! Extended spec cover-path tests — paths that require SPL Token + Ed25519
//! fund-authorization sigverify. Companion to `cover_paths.rs` (which covers
//! the simpler expire / ghosted paths that don't need token flow).
//!
//! Each test:
//!   - Sets up fresh SVM + USDC mint + ATAs + Treasury
//!   - Drives the actual deployed `.so` through the cover-path's handler
//!     sequence using real Anchor ix dispatch + Ed25519 sigverify ix
//!     prepending for fund_project
//!   - Asserts the spec's property predicates after each transition:
//!     `escrow_conservation`, `treasury_monotonic`, `fee_bps_bounded`,
//!     `contract_value_set_on_award`, `escrow_locks_contract_value`,
//!     `single_milestone_in_flight`
//!
//! Spec source: ../../tender.qedspec
//!
//! Cover paths covered here:
//!   - `cover_happy_path_public_full`: complete public-mode happy path
//!     (rfp_create → commit → close → select → fund → start → submit →
//!     accept). The headline production-flow test.
//!
//! Cover paths still pending (each ~30 min using helpers below):
//!   - happy_path_with_reserve (adds reveal_reserve)
//!   - cancel_with_notice_path (fund → cancel_with_notice)
//!   - cancel_with_penalty_path (fund → start → cancel_with_penalty)
//!   - cancel_late_path (fund → start → clock-advance → cancel_late_milestone)
//!   - auto_release_path (fund → start → submit → clock-advance → auto_release)
//!   - dispute_resolve_path (fund → start → submit → reject → resolve × 2)
//!   - dispute_default_path (fund → start → submit → reject → clock-advance → default)
//!   - private_buyer_attest_path (full path + attest_buyer_history)
//!   - private_bidder_attest_path (full path + attest_win)

#![allow(dead_code, unused_imports)]

// Pull in the shared SPL/Ed25519 helpers from sibling test file.
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
    transaction::Transaction,
};
use spl_associated_token_account::get_associated_token_address;
use tender::state::{
    BidderVisibility, BuyerVisibility, MilestoneStatus, PayoutChain, RfpStatus,
};

// ---------------------------------------------------------------------------
// Per-handler ix builders (composable across cover paths)
// ---------------------------------------------------------------------------

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
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("rfp_create");
    rfp
}

fn commit_bid_init_for(
    svm: &mut litesvm::LiteSVM,
    rfp: Pubkey,
    provider: &Keypair,
    mint: Pubkey,
) -> Pubkey {
    let (bid, _) = bid_pda(&rfp, &provider.pubkey());
    let args = tender::instructions::commit_bid_init::CommitBidInitArgs {
        commit_hash: [9u8; 32],
        buyer_envelope_len: 64,
        provider_envelope_len: 64,
        payout_destination: provider.pubkey(),
        payout_chain: PayoutChain::Solana { mint },
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
    svm.send_transaction(tx).expect("commit_bid_init");
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
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("rfp_close_bidding");
}

/// Public-mode select_bid with multi-milestone payouts.
fn select_bid_public_multi(
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
            instructions_sysvar: solana_program::sysvar::instructions::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::SelectBid { args }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("select_bid (public)");
}

/// fund_project — needs Ed25519 sigverify ix prepended.
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

    // Build the Ed25519 sigverify ix for the fund-authorization message.
    let msg = build_fund_auth_message(&rfp, contract_value);
    let sigverify_ix = build_ed25519_sigverify_ix(buyer_signing_key, &msg);

    // Build milestone PDAs as remaining accounts.
    let mut accounts = tender::accounts::FundProject {
        funder: funder.pubkey(),
        buyer: buyer.pubkey(),
        rfp,
        mint,
        funder_ata,
        escrow,
        escrow_ata,
        buyer_reputation,
        instructions_sysvar: solana_program::sysvar::instructions::ID,
        token_program: spl_token::ID,
        associated_token_program: spl_associated_token_account::ID,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for i in 0..milestone_count {
        let (m, _) = milestone_pda(&rfp, i);
        accounts.push(solana_sdk::instruction::AccountMeta::new(m, false));
    }

    let fund_ix = Instruction {
        program_id: tender::ID,
        accounts,
        data: tender::instruction::FundProject {}.data(),
    };

    let tx = Transaction::new_signed_with_payer(
        &[sigverify_ix, fund_ix],
        Some(&funder.pubkey()),
        &[funder],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("fund_project");
}

fn start_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    provider: &Keypair,
    rfp: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::StartMilestone {
            provider: provider.pubkey(),
            rfp,
            milestone,
        }
        .to_account_metas(None),
        data: tender::instruction::StartMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[provider],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("start_milestone");
}

fn submit_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    provider: &Keypair,
    rfp: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::SubmitMilestone {
            provider: provider.pubkey(),
            rfp,
            milestone,
        }
        .to_account_metas(None),
        data: tender::instruction::SubmitMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&provider.pubkey()),
        &[provider],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("submit_milestone");
}

fn accept_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    provider_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, &mint);
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
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
        data: tender::instruction::AcceptMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("accept_milestone");
}

// ===========================================================================
// COVER PATH TEST
// ===========================================================================

/// Spec cover: `cover happy_path_public_full`.
///
/// Full public-mode happy path on the real deployed `.so`:
///   1. rfp_create (public bidder, public buyer)
///   2. commit_bid_init (provider commits 1-milestone bid)
///   3. (clock advance) rfp_close_bidding
///   4. select_bid (PUBLIC mode — winner_provider == bid.provider; no Ed25519
///      binding-sig needed since the bid was signed by the provider main wallet)
///   5. fund_project (Ed25519 fund-auth sigverify ix prepended)
///   6. start_milestone (provider begins)
///   7. submit_milestone (provider submits)
///   8. accept_milestone (buyer accepts; escrow → provider ATA + treasury ATA)
///
/// Property predicates verified after each transition:
///   - `escrow_conservation`
///   - `treasury_monotonic` (across the project)
///   - `fee_bps_bounded`
///   - `contract_value_set_on_award` (after step 4)
///   - `escrow_locks_contract_value` (after step 5)
///
/// Asserted at the end:
///   - rfp.status == Completed (auto-promoted by accept_milestone since 1 ms)
///   - escrow_ata balance == 0 (everything dispersed)
///   - provider_ata balance == 0.975 * contract_value (post-fee net)
///   - treasury_ata balance == 0.025 * contract_value (fee)
///   - buyer_rep.total_rfps == 1, funded_rfps == 1, completed_rfps == 1
///   - provider_rep.total_wins == 1, completed_projects == 1
#[test]
fn cover_happy_path_public_full() {
    let (mut svm, payer) = fresh_svm_with_token();

    // ---- Setup actors ----
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 10 * ONE_SOL).unwrap();

    // Pre-compute the ed25519-dalek signing key for buyer (used by fund_project sigverify)
    let buyer_signing_key = signing_key_from_solana_keypair(&buyer);

    // ---- Setup USDC mint + ATAs + treasury ----
    let (mint, mint_authority) = create_mint(&mut svm, &payer, 6);
    let mint_pk = mint.pubkey();

    let funder_ata = create_ata(&mut svm, &payer, &funder.pubkey(), &mint_pk);
    let provider_ata = create_ata(&mut svm, &payer, &provider.pubkey(), &mint_pk);

    let contract_value: u64 = 1_000_000_000; // 1000 USDC (6 decimals)
    mint_to(&mut svm, &mint_authority, &mint_pk, &funder_ata, contract_value * 2);

    let treasury = init_treasury(&mut svm, &payer, &mint_pk, payer.pubkey());

    // Verify initial treasury state.
    let t0 = fetch_treasury(&svm);
    invariants::treasury_monotonic(0, t0.total_collected);
    assert_eq!(t0.total_collected, 0, "treasury starts at 0");

    // ---- Step 1: rfp_create ----
    let nonce = *b"happy001";
    let rfp = create_rfp_with_visibility(
        &mut svm,
        &buyer,
        nonce,
        BidderVisibility::Public,
        BuyerVisibility::Public,
    );
    let r1 = fetch_rfp(&svm, &rfp);
    assert!(matches!(r1.status, RfpStatus::Open));
    invariants::fee_bps_bounded(&r1);

    // ---- Step 2: commit_bid_init ----
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint_pk);
    let r2 = fetch_rfp(&svm, &rfp);
    assert_eq!(r2.bid_count, 1);

    // ---- Step 3: close bidding ----
    set_clock(&mut svm, r2.bid_close_at + 1);
    close_bidding_ix(&mut svm, &payer, rfp);
    let r3 = fetch_rfp(&svm, &rfp);
    assert!(matches!(r3.status, RfpStatus::Reveal));

    // ---- Step 4: select_bid (PUBLIC mode, single milestone) ----
    select_bid_public_multi(
        &mut svm,
        &buyer,
        rfp,
        bid,
        provider.pubkey(),
        contract_value,
        vec![contract_value],
        vec![86_400],
    );
    let r4 = fetch_rfp(&svm, &rfp);
    assert!(matches!(r4.status, RfpStatus::Awarded));
    invariants::contract_value_set_on_award(&r4);
    invariants::fee_bps_bounded(&r4);

    // ---- Step 5: fund_project (with Ed25519 fund-auth sigverify) ----
    fund_project_ix(
        &mut svm,
        &funder,
        &buyer,
        &buyer_signing_key,
        rfp,
        mint_pk,
        contract_value,
        1, // milestone_count
    );
    let r5 = fetch_rfp(&svm, &rfp);
    let e5 = fetch_escrow(&svm, &rfp);
    assert!(matches!(r5.status, RfpStatus::Funded));
    invariants::escrow_conservation(&e5);
    invariants::escrow_locks_contract_value(&e5, &r5);
    assert_eq!(ata_balance(&svm, &funder_ata), contract_value); // remaining
    let escrow_ata = get_associated_token_address(&escrow_pda(&rfp).0, &mint_pk);
    assert_eq!(ata_balance(&svm, &escrow_ata), contract_value); // escrow has it

    // ---- Step 6: start_milestone(0) ----
    start_milestone_ix(&mut svm, &provider, rfp, 0);
    let r6 = fetch_rfp(&svm, &rfp);
    let m6 = fetch_milestone(&svm, &rfp, 0);
    assert!(matches!(r6.status, RfpStatus::InProgress));
    assert!(matches!(m6.status, MilestoneStatus::Started));
    assert_eq!(r6.active_milestone_index, 0);

    // ---- Step 7: submit_milestone(0) ----
    submit_milestone_ix(&mut svm, &provider, rfp, 0);
    let m7 = fetch_milestone(&svm, &rfp, 0);
    assert!(matches!(m7.status, MilestoneStatus::Submitted));

    // ---- Step 8: accept_milestone(0) — triggers auto-completion ----
    accept_milestone_ix(&mut svm, &buyer, rfp, mint_pk, provider_ata, 0);
    let r8 = fetch_rfp(&svm, &rfp);
    let m8 = fetch_milestone(&svm, &rfp, 0);
    let e8 = fetch_escrow(&svm, &rfp);
    let t8 = fetch_treasury(&svm);

    assert!(matches!(m8.status, MilestoneStatus::Released));
    assert!(matches!(r8.status, RfpStatus::Completed));
    assert_eq!(
        r8.active_milestone_index,
        tender::state::NO_ACTIVE_MILESTONE
    );

    // ---- Property assertions ----
    invariants::escrow_conservation(&e8);
    invariants::fee_bps_bounded(&r8);
    invariants::treasury_monotonic(t0.total_collected, t8.total_collected);

    // ---- Token math checks ----
    let expected_fee = contract_value * 250 / 10000; // 2.5%
    let expected_to_provider = contract_value - expected_fee;
    assert_eq!(
        ata_balance(&svm, &provider_ata),
        expected_to_provider,
        "provider received post-fee net"
    );
    let treasury_ata = get_associated_token_address(&treasury, &mint_pk);
    assert_eq!(
        ata_balance(&svm, &treasury_ata),
        expected_fee,
        "treasury received fee"
    );
    assert_eq!(ata_balance(&svm, &escrow_ata), 0, "escrow drained");

    // ---- Reputation accrual ----
    let br = fetch_buyer_rep(&svm, &buyer.pubkey());
    assert_eq!(br.total_rfps, 1);
    assert_eq!(br.funded_rfps, 1);
    assert_eq!(br.completed_rfps, 1);
    assert_eq!(br.total_locked_usdc, contract_value);
    assert_eq!(br.total_released_usdc, contract_value);

    let pr = fetch_provider_rep(&svm, &provider.pubkey());
    assert_eq!(pr.total_wins, 1);
    assert_eq!(pr.completed_projects, 1);
    assert_eq!(pr.total_won_usdc, contract_value);
    assert_eq!(pr.total_earned_usdc, expected_to_provider);
}

// ===========================================================================
// MORE COVER PATHS — sharing the same SPL + Ed25519 infra
// ===========================================================================

fn cancel_with_notice_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    refund_destination_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::CancelWithNotice {
            buyer: buyer.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            refund_destination_ata,
            buyer_reputation,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::CancelWithNotice { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("cancel_with_notice");
}

fn cancel_with_penalty_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    refund_destination_ata: Pubkey,
    provider_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::CancelWithPenalty {
            buyer: buyer.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            refund_destination_ata,
            provider_ata,
            buyer_reputation,
            provider_reputation,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::CancelWithPenalty { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("cancel_with_penalty");
}

fn cancel_late_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    refund_destination_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::CancelLateMilestone {
            buyer: buyer.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            refund_destination_ata,
            buyer_reputation,
            provider_reputation,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::CancelLateMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("cancel_late_milestone");
}

fn auto_release_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    payer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    provider_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, &mint);
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let (buyer_reputation, _) = buyer_rep_pda(&r.buyer);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::AutoReleaseMilestone {
            payer: payer.pubkey(),
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
        data: tender::instruction::AutoReleaseMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("auto_release_milestone");
}

fn reject_milestone_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (buyer_reputation, _) = buyer_rep_pda(&buyer.pubkey());
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::RejectMilestone {
            buyer: buyer.pubkey(),
            rfp,
            milestone,
            buyer_reputation,
            provider_reputation,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::RejectMilestone { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&buyer.pubkey()),
        &[buyer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("reject_milestone");
}

fn dispute_default_split_ix(
    svm: &mut litesvm::LiteSVM,
    payer: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    refund_destination_ata: Pubkey,
    provider_ata: Pubkey,
    milestone_index: u8,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, &mint);
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let (buyer_reputation, _) = buyer_rep_pda(&r.buyer);
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::DisputeDefaultSplit {
            payer: payer.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            provider_ata,
            refund_destination_ata,
            treasury,
            treasury_ata,
            buyer_reputation,
            provider_reputation,
            system_program: system_program::ID,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::DisputeDefaultSplit { milestone_index }.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &[payer],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("dispute_default_split");
}

/// Common test setup: SVM with mint + ATAs + treasury + funded RFP, ready to
/// drive into any post-fund cover path. Returns the actors + relevant PDAs.
struct FundedFixture {
    svm: litesvm::LiteSVM,
    payer: Keypair,
    buyer: Keypair,
    provider: Keypair,
    funder: Keypair,
    mint: Pubkey,
    funder_ata: Pubkey,
    buyer_ata: Pubkey,
    provider_ata: Pubkey,
    rfp: Pubkey,
    bid: Pubkey,
    contract_value: u64,
}

fn setup_funded_rfp(
    nonce: [u8; 8],
    milestone_amounts: Vec<u64>,
    milestone_durations_secs: Vec<i64>,
) -> FundedFixture {
    let contract_value: u64 = milestone_amounts.iter().sum();
    let (mut svm, payer) = fresh_svm_with_token();
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 10 * ONE_SOL).unwrap();
    let buyer_sk = signing_key_from_solana_keypair(&buyer);

    let (mint_kp, mint_authority) = create_mint(&mut svm, &payer, 6);
    let mint = mint_kp.pubkey();
    let funder_ata = create_ata(&mut svm, &payer, &funder.pubkey(), &mint);
    let buyer_ata = create_ata(&mut svm, &payer, &buyer.pubkey(), &mint);
    let provider_ata = create_ata(&mut svm, &payer, &provider.pubkey(), &mint);
    mint_to(&mut svm, &mint_authority, &mint, &funder_ata, contract_value * 2);
    init_treasury(&mut svm, &payer, &mint, payer.pubkey());

    let rfp = create_rfp_with_visibility(
        &mut svm,
        &buyer,
        nonce,
        BidderVisibility::Public,
        BuyerVisibility::Public,
    );
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint);
    let r = fetch_rfp(&svm, &rfp);
    set_clock(&mut svm, r.bid_close_at + 1);
    close_bidding_ix(&mut svm, &payer, rfp);

    let milestone_count = milestone_amounts.len() as u8;
    select_bid_public_multi(
        &mut svm,
        &buyer,
        rfp,
        bid,
        provider.pubkey(),
        contract_value,
        milestone_amounts,
        milestone_durations_secs,
    );
    fund_project_ix(
        &mut svm,
        &funder,
        &buyer,
        &buyer_sk,
        rfp,
        mint,
        contract_value,
        milestone_count,
    );

    FundedFixture {
        svm,
        payer,
        buyer,
        provider,
        funder,
        mint,
        funder_ata,
        buyer_ata,
        provider_ata,
        rfp,
        bid,
        contract_value,
    }
}

/// Spec cover: `cover cancel_with_notice_path`. Buyer cancels milestone before
/// any start; full refund, no penalty, no reputation hit.
#[test]
fn cover_cancel_with_notice_path() {
    let mut f = setup_funded_rfp(*b"canc_nti", vec![1_000_000_000], vec![86_400]);
    cancel_with_notice_ix(&mut f.svm, &f.buyer, f.rfp, f.mint, f.buyer_ata, 0);
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    assert!(matches!(m.status, MilestoneStatus::CancelledByBuyer));
    invariants::escrow_conservation(&e);
    invariants::fee_bps_bounded(&r);
    assert_eq!(e.total_refunded, f.contract_value);
    assert_eq!(e.total_released, 0);
    let br = fetch_buyer_rep(&f.svm, &f.buyer.pubkey());
    assert_eq!(br.cancelled_milestones, 0, "cancel-with-notice: no counter ding");
    assert_eq!(br.total_refunded_usdc, f.contract_value);
    assert_eq!(ata_balance(&f.svm, &f.buyer_ata), f.contract_value);
}

/// Spec cover: `cover cancel_with_penalty_path`. Buyer cancels mid-flight;
/// 50% penalty goes to provider, 50% refunded.
#[test]
fn cover_cancel_with_penalty_path() {
    let mut f = setup_funded_rfp(*b"canc_pen", vec![1_000_000_000], vec![86_400]);
    start_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    cancel_with_penalty_ix(
        &mut f.svm,
        &f.buyer,
        f.rfp,
        f.mint,
        f.buyer_ata,
        f.provider_ata,
        0,
    );
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    invariants::escrow_conservation(&e);
    invariants::fee_bps_bounded(&r);
    let penalty = f.contract_value * 5000 / 10000; // 50%
    let refund = f.contract_value - penalty;
    assert_eq!(e.total_released, penalty);
    assert_eq!(e.total_refunded, refund);
    assert_eq!(ata_balance(&f.svm, &f.provider_ata), penalty);
    assert_eq!(ata_balance(&f.svm, &f.buyer_ata), refund);
    let br = fetch_buyer_rep(&f.svm, &f.buyer.pubkey());
    assert_eq!(br.cancelled_milestones, 1, "cancel-with-penalty bumps counter");
}

/// Spec cover: `cover cancel_late_path`. Provider missed delivery deadline;
/// full refund, late_milestones counter on provider.
#[test]
fn cover_cancel_late_path() {
    let mut f = setup_funded_rfp(*b"canc_lte", vec![1_000_000_000], vec![86_400]);
    start_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    set_clock(&mut f.svm, m.delivery_deadline + 1);
    cancel_late_milestone_ix(&mut f.svm, &f.buyer, f.rfp, f.mint, f.buyer_ata, 0);
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    invariants::escrow_conservation(&e);
    invariants::fee_bps_bounded(&r);
    assert_eq!(e.total_refunded, f.contract_value);
    assert_eq!(e.total_released, 0);
    let pr = fetch_provider_rep(&f.svm, &f.provider.pubkey());
    assert_eq!(pr.late_milestones, 1, "late counter incremented");
    let br = fetch_buyer_rep(&f.svm, &f.buyer.pubkey());
    assert_eq!(br.cancelled_milestones, 0, "no buyer counter for late");
}

/// Spec cover: `cover auto_release_path`. Provider submits; buyer goes silent;
/// permissionless caller triggers auto-release after review deadline.
#[test]
fn cover_auto_release_path() {
    let mut f = setup_funded_rfp(*b"auto_rel", vec![1_000_000_000], vec![86_400]);
    start_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    submit_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    set_clock(&mut f.svm, m.review_deadline + 1);
    // Permissionless: anyone can call. Use payer (not buyer).
    let payer_for_release = Keypair::new();
    f.svm.airdrop(&payer_for_release.pubkey(), ONE_SOL).unwrap();
    auto_release_milestone_ix(
        &mut f.svm,
        &payer_for_release,
        f.rfp,
        f.mint,
        f.provider_ata,
        0,
    );
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    let mm = fetch_milestone(&f.svm, &f.rfp, 0);
    assert!(matches!(mm.status, MilestoneStatus::Released));
    assert!(matches!(r.status, RfpStatus::Completed));
    invariants::escrow_conservation(&e);
    let fee = f.contract_value * 250 / 10000;
    let net = f.contract_value - fee;
    assert_eq!(ata_balance(&f.svm, &f.provider_ata), net);
}

/// Spec cover: `cover dispute_default_path`. Reject milestone → cool-off
/// expires → default 50/50 split applied permissionlessly.
#[test]
fn cover_dispute_default_path() {
    let mut f = setup_funded_rfp(*b"disp_def", vec![1_000_000_000], vec![86_400]);
    start_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    submit_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    reject_milestone_ix(&mut f.svm, &f.buyer, f.rfp, 0);
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    set_clock(&mut f.svm, m.dispute_deadline + 1);
    let payer_for_split = Keypair::new();
    f.svm.airdrop(&payer_for_split.pubkey(), ONE_SOL).unwrap();
    dispute_default_split_ix(
        &mut f.svm,
        &payer_for_split,
        f.rfp,
        f.mint,
        f.buyer_ata,
        f.provider_ata,
        0,
    );
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    let mm = fetch_milestone(&f.svm, &f.rfp, 0);
    assert!(matches!(mm.status, MilestoneStatus::DisputeDefault));
    assert!(matches!(r.status, RfpStatus::Completed));
    invariants::escrow_conservation(&e);
    invariants::fee_bps_bounded(&r);
    let split = f.contract_value / 2;
    let fee = split * 250 / 10000;
    let provider_net = split - fee;
    let buyer_refund = f.contract_value - split;
    assert_eq!(e.total_released, split);
    assert_eq!(e.total_refunded, buyer_refund);
    assert_eq!(ata_balance(&f.svm, &f.provider_ata), provider_net);
    assert_eq!(ata_balance(&f.svm, &f.buyer_ata), buyer_refund);
}

// ===========================================================================
// MORE COVER PATHS — reserve + dispute_resolve
// ===========================================================================

fn rfp_create_with_reserve(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    nonce: [u8; 8],
    reserve_commitment: [u8; 32],
) -> Pubkey {
    let (rfp, _) = rfp_pda(&buyer.pubkey(), &nonce);
    let mut args = rfp_create_args(
        nonce,
        BidderVisibility::Public,
        BuyerVisibility::Public,
    );
    args.reserve_price_commitment = reserve_commitment;
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
    svm.send_transaction(tx).expect("rfp_create");
    rfp
}

fn reveal_reserve_ix(
    svm: &mut litesvm::LiteSVM,
    buyer: &Keypair,
    rfp: Pubkey,
    reserve_amount: u64,
    reserve_nonce: [u8; 32],
) {
    let args = tender::instructions::reveal_reserve::RevealReserveArgs {
        reserve_amount,
        reserve_nonce,
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
    svm.send_transaction(tx).expect("reveal_reserve");
}

/// Spec cover: `cover happy_path_with_reserve`. Same as happy_path_public_full
/// + reserve commitment + reveal. Verifies the program's SHA-256 commitment
/// flow + reserve-price ceiling on selected bid.
#[test]
fn cover_happy_path_with_reserve() {
    use solana_sha256_hasher::hashv;
    let (mut svm, payer) = fresh_svm_with_token();
    let buyer = Keypair::new();
    svm.airdrop(&buyer.pubkey(), 10 * ONE_SOL).unwrap();
    let provider = Keypair::new();
    svm.airdrop(&provider.pubkey(), 10 * ONE_SOL).unwrap();
    let funder = Keypair::new();
    svm.airdrop(&funder.pubkey(), 10 * ONE_SOL).unwrap();
    let buyer_sk = signing_key_from_solana_keypair(&buyer);

    // SPL setup
    let (mint_kp, mint_authority) = create_mint(&mut svm, &payer, 6);
    let mint = mint_kp.pubkey();
    let funder_ata = create_ata(&mut svm, &payer, &funder.pubkey(), &mint);
    let provider_ata = create_ata(&mut svm, &payer, &provider.pubkey(), &mint);
    let contract_value: u64 = 800_000_000; // 800 USDC (under reserve)
    let reserve_amount: u64 = 1_000_000_000; // 1000 USDC max
    mint_to(&mut svm, &mint_authority, &mint, &funder_ata, contract_value * 2);
    init_treasury(&mut svm, &payer, &mint, payer.pubkey());

    // Build SHA-256 commitment
    let reserve_nonce = [42u8; 32];
    let commitment = hashv(&[&reserve_amount.to_le_bytes(), &reserve_nonce]).to_bytes();

    // Create RFP with reserve commitment
    let rfp = rfp_create_with_reserve(&mut svm, &buyer, *b"resrv001", commitment);

    // Bid + close
    let bid = commit_bid_init_for(&mut svm, rfp, &provider, mint);
    let r = fetch_rfp(&svm, &rfp);
    set_clock(&mut svm, r.bid_close_at + 1);
    close_bidding_ix(&mut svm, &payer, rfp);

    // Reveal reserve (proves SHA-256 commitment was honest)
    reveal_reserve_ix(&mut svm, &buyer, rfp, reserve_amount, reserve_nonce);
    let r = fetch_rfp(&svm, &rfp);
    assert_eq!(
        r.reserve_price_revealed, reserve_amount,
        "reveal_reserve sets the field"
    );

    // Select with contract_value < reserve (must succeed)
    select_bid_public_multi(
        &mut svm,
        &buyer,
        rfp,
        bid,
        provider.pubkey(),
        contract_value,
        vec![contract_value],
        vec![86_400],
    );
    let r = fetch_rfp(&svm, &rfp);
    invariants::contract_value_set_on_award(&r);

    // Continue happy path through fund + accept
    fund_project_ix(
        &mut svm, &funder, &buyer, &buyer_sk, rfp, mint, contract_value, 1,
    );
    start_milestone_ix(&mut svm, &provider, rfp, 0);
    submit_milestone_ix(&mut svm, &provider, rfp, 0);
    accept_milestone_ix(&mut svm, &buyer, rfp, mint, provider_ata, 0);

    let r = fetch_rfp(&svm, &rfp);
    let e = fetch_escrow(&svm, &rfp);
    assert!(matches!(r.status, RfpStatus::Completed));
    invariants::escrow_conservation(&e);
    assert!(contract_value <= reserve_amount, "honored reserve ceiling");
}

fn resolve_dispute_ix(
    svm: &mut litesvm::LiteSVM,
    party: &Keypair,
    rfp: Pubkey,
    mint: Pubkey,
    refund_destination_ata: Pubkey,
    provider_ata: Pubkey,
    milestone_index: u8,
    split_to_provider_bps: u16,
) {
    let (milestone, _) = milestone_pda(&rfp, milestone_index);
    let (escrow, _) = escrow_pda(&rfp);
    let escrow_ata = get_associated_token_address(&escrow, &mint);
    let (treasury, _) = treasury_pda();
    let treasury_ata = get_associated_token_address(&treasury, &mint);
    let r = fetch_rfp(svm, &rfp);
    let provider = r.winner_provider.unwrap();
    let (provider_reputation, _) = provider_rep_pda(&provider);
    let (buyer_reputation, _) = buyer_rep_pda(&r.buyer);
    let args = tender::instructions::resolve_dispute::ResolveDisputeArgs {
        split_to_provider_bps,
    };
    let ix = Instruction {
        program_id: tender::ID,
        accounts: tender::accounts::ResolveDispute {
            party: party.pubkey(),
            rfp,
            milestone,
            escrow,
            mint,
            escrow_ata,
            provider_ata,
            refund_destination_ata,
            treasury,
            treasury_ata,
            buyer_reputation,
            provider_reputation,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: tender::instruction::ResolveDispute {
            milestone_index,
            args,
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&party.pubkey()),
        &[party],
        svm.latest_blockhash(),
    );
    svm.send_transaction(tx).expect("resolve_dispute");
}

/// Spec cover: `cover dispute_resolve_path`. Buyer rejects → both parties
/// propose matching split → escrow disperses per split. Tests the 2-step
/// settlement flow.
#[test]
fn cover_dispute_resolve_path() {
    let mut f = setup_funded_rfp(*b"disp_rsv", vec![1_000_000_000], vec![86_400]);
    start_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    submit_milestone_ix(&mut f.svm, &f.provider, f.rfp, 0);
    reject_milestone_ix(&mut f.svm, &f.buyer, f.rfp, 0);

    // Both parties propose 60/40 split (60% to provider, 40% refund)
    let split = 6000u16;
    resolve_dispute_ix(
        &mut f.svm, &f.buyer, f.rfp, f.mint, f.buyer_ata, f.provider_ata, 0, split,
    );
    // After buyer's call, provider hasn't proposed yet — milestone still Disputed.
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    assert!(matches!(m.status, MilestoneStatus::Disputed));
    assert_eq!(m.buyer_proposed_split_bps, split);

    resolve_dispute_ix(
        &mut f.svm, &f.provider, f.rfp, f.mint, f.buyer_ata, f.provider_ata, 0, split,
    );
    // Now both proposed matching → settled.
    let m = fetch_milestone(&f.svm, &f.rfp, 0);
    let r = fetch_rfp(&f.svm, &f.rfp);
    let e = fetch_escrow(&f.svm, &f.rfp);
    assert!(matches!(m.status, MilestoneStatus::DisputeResolved));
    assert!(matches!(r.status, RfpStatus::Completed));
    invariants::escrow_conservation(&e);

    // Token math: provider gets 60% net of fee, buyer gets 40%, treasury gets fee.
    let provider_share = f.contract_value * split as u64 / 10000;
    let fee = provider_share * 250 / 10000;
    let provider_net = provider_share - fee;
    let buyer_refund = f.contract_value - provider_share;
    assert_eq!(ata_balance(&f.svm, &f.provider_ata), provider_net);
    assert_eq!(ata_balance(&f.svm, &f.buyer_ata), buyer_refund);
}
