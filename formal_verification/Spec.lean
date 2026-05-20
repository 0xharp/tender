import Mathlib.Algebra.BigOperators.Fin
import QEDGen.Solana.Account
import QEDGenMathlib.IndexedState

namespace Tender

open QEDGen.Solana
open QEDGen.Solana.IndexedState

abbrev MIN_MILESTONE_COUNT : Nat := 1
abbrev MAX_MILESTONE_COUNT : Nat := 8
abbrev MAX_ENVELOPE_LEN : Nat := 65536
abbrev DEFAULT_FUNDING_WINDOW_SECS : Nat := 259200
abbrev DEFAULT_REVIEW_WINDOW_SECS : Nat := 604800
abbrev DEFAULT_DISPUTE_COOLOFF_SECS : Nat := 1209600
abbrev DEFAULT_CANCEL_NOTICE_SECS : Nat := 259200
abbrev DEFAULT_MAX_ITERATIONS : Nat := 2
abbrev MAX_WINDOW_SECS : Nat := 1000000000
abbrev PLATFORM_FEE_BPS : Nat := 250
abbrev ABANDON_PENALTY_BPS : Nat := 5000
abbrev BPS_DENOMINATOR : Nat := 10000
abbrev NO_ACTIVE_MILESTONE : Nat := 255
abbrev SPLIT_NOT_PROPOSED : Nat := 65535
abbrev ENVELOPE_KIND_BUYER : Nat := 0
abbrev ENVELOPE_KIND_PROVIDER : Nat := 1
abbrev CANCEL_KIND_NOTICE : Nat := 0
abbrev CANCEL_KIND_PENALTY : Nat := 1
abbrev CANCEL_KIND_LATE : Nat := 2
abbrev RFP_DRAFT : Nat := 0
abbrev RFP_OPEN : Nat := 1
abbrev RFP_BIDS_CLOSED : Nat := 2
abbrev RFP_REVEAL : Nat := 3
abbrev RFP_AWARDED : Nat := 4
abbrev RFP_FUNDED : Nat := 5
abbrev RFP_IN_PROGRESS : Nat := 6
abbrev RFP_COMPLETED : Nat := 7
abbrev RFP_CANCELLED : Nat := 8
abbrev RFP_GHOSTED : Nat := 9
abbrev RFP_DISPUTED : Nat := 10
abbrev RFP_EXPIRED : Nat := 11
abbrev BID_INITIALIZING : Nat := 0
abbrev BID_COMMITTED : Nat := 1
abbrev BID_SELECTED : Nat := 2
abbrev BID_WITHDRAWN : Nat := 3
abbrev BID_EXPIRED : Nat := 4
abbrev MS_PENDING : Nat := 0
abbrev MS_STARTED : Nat := 1
abbrev MS_SUBMITTED : Nat := 2
abbrev MS_ACCEPTED : Nat := 3
abbrev MS_RELEASED : Nat := 4
abbrev MS_DISPUTED : Nat := 5
abbrev MS_DISPUTE_RESOLVED : Nat := 6
abbrev MS_DISPUTE_DEFAULT : Nat := 7
abbrev MS_CANCELLED_BY_BUYER : Nat := 8
abbrev BV_PUBLIC : Nat := 0
abbrev BV_BUYER_ONLY : Nat := 1
abbrev BUYER_VIS_PUBLIC : Nat := 0
abbrev BUYER_VIS_PRIVATE : Nat := 1
abbrev PAYOUT_SOLANA : Nat := 0
abbrev PAYOUT_CROSSCHAIN : Nat := 1

abbrev AccountIdx : Type := Fin MAX_MILESTONE_COUNT

inductive Status where
  | Uninitialized
  | Active
  deriving Repr, DecidableEq, BEq

structure State where
  rfp_buyer : Nat
  rfp_buyer_encryption_pubkey : Nat
  rfp_title_hash : Nat
  rfp_category : Nat
  rfp_bid_open_at : Int
  rfp_bid_close_at : Int
  rfp_reveal_close_at : Int
  rfp_milestone_count : Nat
  rfp_bidder_visibility : Nat
  rfp_buyer_visibility : Nat
  rfp_buyer_attested : Nat
  rfp_status : Nat
  rfp_has_winner : Nat
  rfp_winner : Nat
  rfp_has_winner_provider : Nat
  rfp_winner_provider : Nat
  rfp_contract_value : Nat
  rfp_bid_count : Nat
  rfp_created_at : Int
  rfp_reserve_price_commitment : Nat
  rfp_reserve_price_revealed : Nat
  rfp_funding_window_secs : Int
  rfp_review_window_secs : Int
  rfp_dispute_cooloff_secs : Int
  rfp_cancel_notice_secs : Int
  rfp_max_iterations : Nat
  rfp_milestone_amounts : Map MAX_MILESTONE_COUNT U64
  rfp_milestone_durations_secs : Map MAX_MILESTONE_COUNT I64
  rfp_active_milestone_index : Nat
  rfp_funding_deadline : Int
  rfp_fee_bps : Nat
  bid_rfp : Nat
  bid_buyer : Nat
  bid_bid_close_at : Int
  bid_provider : Nat
  bid_commit_hash : Nat
  bid_buyer_envelope_len : Nat
  bid_provider_envelope_len : Nat
  bid_buyer_envelope_size : Nat
  bid_provider_envelope_size : Nat
  bid_submitted_at : Int
  bid_status : Nat
  bid_payout_destination : Nat
  bid_payout_chain : Nat
  bid_winner_attested : Nat
  milestone_rfp : Nat
  milestone_index : Nat
  milestone_amount : Nat
  milestone_status : Nat
  milestone_iteration_count : Nat
  milestone_started_at : Int
  milestone_submitted_at : Int
  milestone_review_deadline : Int
  milestone_disputed_at : Int
  milestone_dispute_deadline : Int
  milestone_buyer_proposed_split_bps : Nat
  milestone_provider_proposed_split_bps : Nat
  milestone_delivery_deadline : Int
  escrow_rfp : Nat
  escrow_mint : Nat
  escrow_total_locked : Nat
  escrow_total_released : Nat
  escrow_total_refunded : Nat
  escrow_funded_at : Int
  escrow_initialized : Nat
  treasury_authority : Nat
  treasury_total_collected : Nat
  treasury_initialized : Nat
  buyer_rep_buyer : Nat
  buyer_rep_total_rfps : Nat
  buyer_rep_funded_rfps : Nat
  buyer_rep_completed_rfps : Nat
  buyer_rep_ghosted_rfps : Nat
  buyer_rep_disputed_milestones : Nat
  buyer_rep_cancelled_milestones : Nat
  buyer_rep_total_locked_usdc : Nat
  buyer_rep_total_released_usdc : Nat
  buyer_rep_total_refunded_usdc : Nat
  buyer_rep_last_updated : Int
  buyer_rep_initialized : Nat
  provider_rep_provider : Nat
  provider_rep_total_wins : Nat
  provider_rep_completed_projects : Nat
  provider_rep_disputed_milestones : Nat
  provider_rep_abandoned_projects : Nat
  provider_rep_late_milestones : Nat
  provider_rep_total_won_usdc : Nat
  provider_rep_total_earned_usdc : Nat
  provider_rep_total_disputed_usdc : Nat
  provider_rep_last_updated : Int
  provider_rep_initialized : Nat
  main_buyer_rep_buyer : Nat
  main_buyer_rep_total_rfps : Nat
  main_buyer_rep_funded_rfps : Nat
  main_buyer_rep_completed_rfps : Nat
  main_buyer_rep_ghosted_rfps : Nat
  main_buyer_rep_disputed_milestones : Nat
  main_buyer_rep_cancelled_milestones : Nat
  main_buyer_rep_total_locked_usdc : Nat
  main_buyer_rep_total_released_usdc : Nat
  main_buyer_rep_total_refunded_usdc : Nat
  main_buyer_rep_last_updated : Int
  main_buyer_rep_initialized : Nat
  main_provider_rep_provider : Nat
  main_provider_rep_total_wins : Nat
  main_provider_rep_completed_projects : Nat
  main_provider_rep_disputed_milestones : Nat
  main_provider_rep_abandoned_projects : Nat
  main_provider_rep_late_milestones : Nat
  main_provider_rep_total_won_usdc : Nat
  main_provider_rep_total_earned_usdc : Nat
  main_provider_rep_total_disputed_usdc : Nat
  main_provider_rep_last_updated : Int
  main_provider_rep_initialized : Nat
  win_receipt_bid : Nat
  win_receipt_main_wallet : Nat
  win_receipt_attested_at : Int
  win_receipt_claimed : Nat
  now : Int
  status : Status

def init_treasuryTransition (s : State) (signer : Pubkey) (authority : Nat) : Option State :=
  if s.status = .Uninitialized ∧ (s.treasury_initialized = 0) then
    some { s with treasury_total_collected := 0, treasury_initialized := 1, status := .Active }
  else none

def rfp_createTransition (s : State) (signer : Pubkey) (rfp_nonce : Nat) (buyer_encryption_pubkey : Nat) (title_hash : Nat) (category : Nat) (bid_open_at : Int) (bid_close_at : Int) (reveal_close_at : Int) (bidder_visibility : Nat) (buyer_visibility : Nat) (reserve_price_commitment : Nat) (funding_window_secs : Int) (review_window_secs : Int) (dispute_cooloff_secs : Int) (cancel_notice_secs : Int) (max_iterations : Nat) : Option State :=
  if s.status = .Active ∧ (bid_open_at < bid_close_at) ∧ (bid_close_at < reveal_close_at) ∧ (funding_window_secs ≥ (((0) : Int))) ∧ (review_window_secs ≥ (((0) : Int))) ∧ (dispute_cooloff_secs ≥ (((0) : Int))) ∧ (cancel_notice_secs ≥ (((0) : Int))) ∧ (250 ≤ 10000) then
    some { s with rfp_buyer_encryption_pubkey := buyer_encryption_pubkey, rfp_title_hash := title_hash, rfp_category := category, rfp_bid_open_at := bid_open_at, rfp_bid_close_at := bid_close_at, rfp_reveal_close_at := reveal_close_at, rfp_bidder_visibility := bidder_visibility, rfp_buyer_visibility := buyer_visibility, rfp_reserve_price_commitment := reserve_price_commitment, rfp_funding_window_secs := funding_window_secs, rfp_review_window_secs := review_window_secs, rfp_dispute_cooloff_secs := dispute_cooloff_secs, rfp_cancel_notice_secs := cancel_notice_secs, rfp_max_iterations := max_iterations, rfp_milestone_count := 0, rfp_buyer_attested := 0, rfp_status := 1, rfp_has_winner := 0, rfp_has_winner_provider := 0, rfp_contract_value := 0, rfp_bid_count := 0, rfp_created_at := s.now, rfp_reserve_price_revealed := 0, rfp_active_milestone_index := 255, rfp_funding_deadline := 0, rfp_fee_bps := 250, status := .Active }
  else none

def rfp_close_biddingTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ (s.rfp_status = 1) ∧ (s.now ≥ s.rfp_bid_close_at) then
    some { s with rfp_status := 3, status := .Active }
  else none

def reveal_reserveTransition (s : State) (signer : Pubkey) (reserve_amount : Nat) (reserve_nonce : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ ((s.rfp_status = 3) ∨ (s.rfp_status = 2)) ∧ (s.rfp_reserve_price_revealed = 0) then
    some { s with status := .Active }
  else none

def commit_bid_initTransition (s : State) (signer : Pubkey) (commit_hash : Nat) (buyer_envelope_len : Nat) (provider_envelope_len : Nat) (payout_destination : Nat) (payout_chain : Nat) : Option State :=
  if s.status = .Active ∧ (buyer_envelope_len > 0) ∧ (provider_envelope_len > 0) ∧ (buyer_envelope_len ≤ 65536) ∧ (provider_envelope_len ≤ 65536) ∧ (payout_chain = 0) ∧ (s.rfp_status = 1) ∧ (s.now ≥ s.rfp_bid_open_at) ∧ (s.now < s.rfp_bid_close_at) then
    some { s with bid_rfp := s.rfp_buyer, bid_buyer := s.rfp_buyer, bid_bid_close_at := s.rfp_bid_close_at, bid_commit_hash := commit_hash, bid_buyer_envelope_len := buyer_envelope_len, bid_provider_envelope_len := provider_envelope_len, bid_payout_destination := payout_destination, bid_payout_chain := payout_chain, bid_buyer_envelope_size := 0, bid_provider_envelope_size := 0, bid_submitted_at := s.now, bid_status := 0, bid_winner_attested := 0, status := .Active }
  else none

def delegate_bidTransition (s : State) (signer : Pubkey) : Option State :=
  let provider := signer
  if s.status = .Active ∧ (s.bid_status = 0) then
    some { s with status := .Active }
  else none

def write_bid_chunkTransition (s : State) (signer : Pubkey) (envelope_kind : Nat) (offset : Nat) (data_len : Nat) : Option State :=
  let provider := signer
  if s.status = .Active ∧ (s.bid_status = 0) ∧ ((envelope_kind = 0) ∨ (envelope_kind = 1)) then
    some { s with bid_submitted_at := s.now, status := .Active }
  else none

def finalize_bidTransition (s : State) (signer : Pubkey) : Option State :=
  let provider := signer
  if s.status = .Active ∧ (s.bid_status = 0) ∧ (s.bid_buyer_envelope_size = s.bid_buyer_envelope_len) ∧ (s.bid_provider_envelope_size = s.bid_provider_envelope_len) then
    some { s with bid_status := 1, status := .Active }
  else none

def open_reveal_windowTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ (s.now ≥ s.bid_bid_close_at) ∧ (s.bid_status = 1) then
    some { s with status := .Active }
  else none

def withdraw_bidTransition (s : State) (signer : Pubkey) : Option State :=
  let provider := signer
  if s.status = .Active ∧ ((s.bid_status = 0) ∨ (s.bid_status = 1)) ∧ (s.now < s.bid_bid_close_at) then
    some { s with bid_status := 3, status := .Active }
  else none

def close_withdrawn_bidTransition (s : State) (signer : Pubkey) : Option State :=
  let provider := signer
  if s.status = .Active ∧ (s.bid_status = 3) then
    some { s with status := .Active }
  else none

def select_bidTransition (s : State) (signer : Pubkey) (winner_provider : Nat) (contract_value : Nat) (milestone_count : Nat) (milestone_amounts_sum : Nat) (milestone_amounts_all_positive : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ ((s.rfp_status = 3) ∨ (s.rfp_status = 2)) ∧ (s.now < s.rfp_reveal_close_at) ∧ (contract_value > 0) ∧ ((s.rfp_reserve_price_revealed = 0) ∨ (contract_value ≤ s.rfp_reserve_price_revealed)) ∧ (milestone_count ≥ 1) ∧ (milestone_count ≤ 8) ∧ (milestone_amounts_sum = contract_value) ∧ (milestone_amounts_all_positive = 1) ∧ ((s.bid_status = 0) ∨ (s.bid_status = 1)) ∧ (s.rfp_funding_window_secs ≤ (((1000000000) : Int))) then
    some { s with rfp_has_winner := 1, rfp_has_winner_provider := 1, rfp_winner_provider := winner_provider, rfp_contract_value := contract_value, rfp_milestone_count := milestone_count, rfp_status := 4, rfp_funding_deadline := s.now + s.rfp_funding_window_secs, buyer_rep_initialized := 1, buyer_rep_last_updated := s.now, provider_rep_initialized := 1, provider_rep_last_updated := s.now, status := .Active }
  else none

def fund_projectTransition (s : State) (signer : Pubkey) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ (s.rfp_status = 4) ∧ (s.now ≤ s.rfp_funding_deadline) ∧ (s.rfp_contract_value > 0) then
    some { s with escrow_total_locked := s.rfp_contract_value, escrow_total_released := 0, escrow_total_refunded := 0, escrow_funded_at := s.now, escrow_initialized := 1, rfp_status := 5, buyer_rep_last_updated := s.now, status := .Active }
  else none

def start_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let provider := signer
  if s.status = .Active ∧ ((s.rfp_status = 5) ∨ (s.rfp_status = 6)) ∧ (s.rfp_has_winner_provider = 1) ∧ (milestone_index < 8) ∧ (s.rfp_active_milestone_index = 255) ∧ (s.milestone_status = 0) then
    some { s with milestone_status := 1, milestone_started_at := s.now, rfp_active_milestone_index := milestone_index, rfp_status := 6, status := .Active }
  else none

def submit_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let provider := signer
  if s.status = .Active ∧ ((s.rfp_status = 5) ∨ (s.rfp_status = 6)) ∧ (s.rfp_has_winner_provider = 1) ∧ (s.milestone_status = 1) ∧ (s.rfp_review_window_secs ≤ (((1000000000) : Int))) then
    some { s with milestone_status := 2, milestone_submitted_at := s.now, milestone_review_deadline := s.now + s.rfp_review_window_secs, rfp_status := 6, status := .Active }
  else none

def accept_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ ((s.rfp_status = 5) ∨ (s.rfp_status = 6)) ∧ (s.milestone_status = 2) ∧ (s.rfp_has_winner_provider = 1) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 4, rfp_active_milestone_index := 255, provider_rep_provider := s.rfp_winner_provider, provider_rep_initialized := 1, provider_rep_last_updated := s.now, buyer_rep_initialized := 1, buyer_rep_last_updated := s.now, status := .Active }
  else none

def auto_release_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  if s.status = .Active ∧ ((s.rfp_status = 5) ∨ (s.rfp_status = 6)) ∧ (s.milestone_status = 2) ∧ (s.now > s.milestone_review_deadline) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 4, rfp_active_milestone_index := 255, provider_rep_last_updated := s.now, buyer_rep_last_updated := s.now, status := .Active }
  else none

def request_changesTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ (s.milestone_status = 2) ∧ (s.now ≤ s.milestone_review_deadline) then
    some { s with milestone_status := 1, milestone_review_deadline := 0, status := .Active }
  else none

def reject_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ (s.milestone_status = 2) ∧ (s.now ≤ s.milestone_review_deadline) ∧ (s.rfp_dispute_cooloff_secs ≤ (((1000000000) : Int))) then
    some { s with milestone_status := 5, milestone_disputed_at := s.now, milestone_dispute_deadline := s.now + s.rfp_dispute_cooloff_secs, milestone_buyer_proposed_split_bps := 65535, milestone_provider_proposed_split_bps := 65535, rfp_status := 10, buyer_rep_last_updated := s.now, provider_rep_last_updated := s.now, status := .Active }
  else none

def cancel_with_noticeTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ (s.milestone_status = 0) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 8, buyer_rep_last_updated := s.now, status := .Active }
  else none

def cancel_with_penaltyTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ ((s.milestone_status = 1) ∨ (s.milestone_status = 2)) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 8, rfp_active_milestone_index := 255, buyer_rep_last_updated := s.now, provider_rep_last_updated := s.now, status := .Active }
  else none

def cancel_late_milestoneTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  let buyer := signer
  if s.status = .Active ∧ (s.milestone_status = 1) ∧ (s.milestone_delivery_deadline > (((0) : Int))) ∧ (s.now > s.milestone_delivery_deadline) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 8, rfp_active_milestone_index := 255, buyer_rep_last_updated := s.now, provider_rep_last_updated := s.now, status := .Active }
  else none

def mark_buyer_ghostedTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ (s.rfp_status = 4) ∧ (s.now > s.rfp_funding_deadline) then
    some { s with rfp_status := 9, buyer_rep_last_updated := s.now, status := .Active }
  else none

def expire_rfpTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ ((s.rfp_status = 3) ∨ (s.rfp_status = 2)) ∧ ((s.rfp_bid_count = 0) ∨ (s.now > s.rfp_reveal_close_at)) then
    some { s with rfp_status := 11, status := .Active }
  else none

def resolve_disputeTransition (s : State) (signer : Pubkey) (milestone_index : Nat) (split_to_provider_bps : Nat) : Option State :=
  if s.status = .Active ∧ (split_to_provider_bps ≤ 10000) ∧ (s.milestone_status = 5) ∧ (s.now ≤ s.milestone_dispute_deadline) then
    some { s with status := .Active }
  else none

def dispute_default_splitTransition (s : State) (signer : Pubkey) (milestone_index : Nat) : Option State :=
  if s.status = .Active ∧ (s.milestone_status = 5) ∧ (s.now > s.milestone_dispute_deadline) ∧ (s.escrow_total_locked ≥ s.escrow_total_released + s.escrow_total_refunded + s.milestone_amount) ∧ (s.rfp_fee_bps = 250) then
    some { s with milestone_status := 7, rfp_active_milestone_index := 255, buyer_rep_last_updated := s.now, provider_rep_last_updated := s.now, status := .Active }
  else none

def attest_buyer_historyTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ (s.rfp_buyer_visibility = 1) ∧ (s.rfp_status = 7) ∧ (s.rfp_buyer_attested = 0) then
    some { s with main_buyer_rep_initialized := 1, main_buyer_rep_last_updated := s.now, rfp_buyer_attested := 1, status := .Active }
  else none

def attest_winTransition (s : State) (signer : Pubkey) : Option State :=
  if s.status = .Active ∧ (s.rfp_bidder_visibility = 1) ∧ (s.rfp_status = 7) ∧ (s.rfp_has_winner = 1) ∧ (s.win_receipt_claimed = 0) then
    some { s with main_provider_rep_initialized := 1, main_provider_rep_last_updated := s.now, win_receipt_attested_at := s.now, win_receipt_claimed := 1, status := .Active }
  else none

inductive Operation where
  | init_treasury (authority : Nat)
  | rfp_create (rfp_nonce : Nat) (buyer_encryption_pubkey : Nat) (title_hash : Nat) (category : Nat) (bid_open_at : Int) (bid_close_at : Int) (reveal_close_at : Int) (bidder_visibility : Nat) (buyer_visibility : Nat) (reserve_price_commitment : Nat) (funding_window_secs : Int) (review_window_secs : Int) (dispute_cooloff_secs : Int) (cancel_notice_secs : Int) (max_iterations : Nat)
  | rfp_close_bidding
  | reveal_reserve (reserve_amount : Nat) (reserve_nonce : Nat)
  | commit_bid_init (commit_hash : Nat) (buyer_envelope_len : Nat) (provider_envelope_len : Nat) (payout_destination : Nat) (payout_chain : Nat)
  | delegate_bid
  | write_bid_chunk (envelope_kind : Nat) (offset : Nat) (data_len : Nat)
  | finalize_bid
  | open_reveal_window
  | withdraw_bid
  | close_withdrawn_bid
  | select_bid (winner_provider : Nat) (contract_value : Nat) (milestone_count : Nat) (milestone_amounts_sum : Nat) (milestone_amounts_all_positive : Nat)
  | fund_project
  | start_milestone (milestone_index : Nat)
  | submit_milestone (milestone_index : Nat)
  | accept_milestone (milestone_index : Nat)
  | auto_release_milestone (milestone_index : Nat)
  | request_changes (milestone_index : Nat)
  | reject_milestone (milestone_index : Nat)
  | cancel_with_notice (milestone_index : Nat)
  | cancel_with_penalty (milestone_index : Nat)
  | cancel_late_milestone (milestone_index : Nat)
  | mark_buyer_ghosted
  | expire_rfp
  | resolve_dispute (milestone_index : Nat) (split_to_provider_bps : Nat)
  | dispute_default_split (milestone_index : Nat)
  | attest_buyer_history
  | attest_win

def applyOp (s : State) (signer : Pubkey) : Operation → Option State
  | .init_treasury authority => init_treasuryTransition s signer authority
  | .rfp_create rfp_nonce buyer_encryption_pubkey title_hash category bid_open_at bid_close_at reveal_close_at bidder_visibility buyer_visibility reserve_price_commitment funding_window_secs review_window_secs dispute_cooloff_secs cancel_notice_secs max_iterations => rfp_createTransition s signer rfp_nonce buyer_encryption_pubkey title_hash category bid_open_at bid_close_at reveal_close_at bidder_visibility buyer_visibility reserve_price_commitment funding_window_secs review_window_secs dispute_cooloff_secs cancel_notice_secs max_iterations
  | .rfp_close_bidding => rfp_close_biddingTransition s signer
  | .reveal_reserve reserve_amount reserve_nonce => reveal_reserveTransition s signer reserve_amount reserve_nonce
  | .commit_bid_init commit_hash buyer_envelope_len provider_envelope_len payout_destination payout_chain => commit_bid_initTransition s signer commit_hash buyer_envelope_len provider_envelope_len payout_destination payout_chain
  | .delegate_bid => delegate_bidTransition s signer
  | .write_bid_chunk envelope_kind offset data_len => write_bid_chunkTransition s signer envelope_kind offset data_len
  | .finalize_bid => finalize_bidTransition s signer
  | .open_reveal_window => open_reveal_windowTransition s signer
  | .withdraw_bid => withdraw_bidTransition s signer
  | .close_withdrawn_bid => close_withdrawn_bidTransition s signer
  | .select_bid winner_provider contract_value milestone_count milestone_amounts_sum milestone_amounts_all_positive => select_bidTransition s signer winner_provider contract_value milestone_count milestone_amounts_sum milestone_amounts_all_positive
  | .fund_project => fund_projectTransition s signer
  | .start_milestone milestone_index => start_milestoneTransition s signer milestone_index
  | .submit_milestone milestone_index => submit_milestoneTransition s signer milestone_index
  | .accept_milestone milestone_index => accept_milestoneTransition s signer milestone_index
  | .auto_release_milestone milestone_index => auto_release_milestoneTransition s signer milestone_index
  | .request_changes milestone_index => request_changesTransition s signer milestone_index
  | .reject_milestone milestone_index => reject_milestoneTransition s signer milestone_index
  | .cancel_with_notice milestone_index => cancel_with_noticeTransition s signer milestone_index
  | .cancel_with_penalty milestone_index => cancel_with_penaltyTransition s signer milestone_index
  | .cancel_late_milestone milestone_index => cancel_late_milestoneTransition s signer milestone_index
  | .mark_buyer_ghosted => mark_buyer_ghostedTransition s signer
  | .expire_rfp => expire_rfpTransition s signer
  | .resolve_dispute milestone_index split_to_provider_bps => resolve_disputeTransition s signer milestone_index split_to_provider_bps
  | .dispute_default_split milestone_index => dispute_default_splitTransition s signer milestone_index
  | .attest_buyer_history => attest_buyer_historyTransition s signer
  | .attest_win => attest_winTransition s signer

/-- Property: escrow_conservation. -/
def escrow_conservation (s : State) : Prop :=
  s.escrow_initialized = 1 → s.escrow_total_released + s.escrow_total_refunded ≤ s.escrow_total_locked

/-- Property: treasury_monotonic. -/
def treasury_monotonic (s : State) : Prop :=
  s.treasury_total_collected ≥ 0

/-- Property: buyer_rep_counters_nonneg. -/
def buyer_rep_counters_nonneg (s : State) : Prop :=
  s.buyer_rep_total_rfps ≥ 0 ∧ s.buyer_rep_funded_rfps ≥ 0 ∧ s.buyer_rep_completed_rfps ≥ 0 ∧ s.buyer_rep_ghosted_rfps ≥ 0 ∧ s.buyer_rep_disputed_milestones ≥ 0 ∧ s.buyer_rep_cancelled_milestones ≥ 0 ∧ s.buyer_rep_total_locked_usdc ≥ 0 ∧ s.buyer_rep_total_released_usdc ≥ 0 ∧ s.buyer_rep_total_refunded_usdc ≥ 0

/-- Property: provider_rep_counters_nonneg. -/
def provider_rep_counters_nonneg (s : State) : Prop :=
  s.provider_rep_total_wins ≥ 0 ∧ s.provider_rep_completed_projects ≥ 0 ∧ s.provider_rep_disputed_milestones ≥ 0 ∧ s.provider_rep_abandoned_projects ≥ 0 ∧ s.provider_rep_late_milestones ≥ 0 ∧ s.provider_rep_total_won_usdc ≥ 0 ∧ s.provider_rep_total_earned_usdc ≥ 0 ∧ s.provider_rep_total_disputed_usdc ≥ 0

/-- Property: buyer_attest_at_most_once. -/
def buyer_attest_at_most_once (s : State) : Prop :=
  s.rfp_buyer_attested ≤ 1

/-- Property: win_attest_at_most_once. -/
def win_attest_at_most_once (s : State) : Prop :=
  s.win_receipt_claimed ≤ 1

/-- Property: single_milestone_in_flight. -/
def single_milestone_in_flight (s : State) : Prop :=
  (s.rfp_active_milestone_index = 255) → ¬((s.milestone_status = 1 ∨ s.milestone_status = 2))

/-- Property: bid_writes_gated_by_window. -/
def bid_writes_gated_by_window (s : State) : Prop :=
  s.bid_buyer ≠ 0 ∧ s.bid_status = 0 → s.now < s.bid_bid_close_at

/-- Property: bid_finalize_requires_committed_envelopes. -/
def bid_finalize_requires_committed_envelopes (s : State) : Prop :=
  s.bid_status = 1 → s.bid_buyer_envelope_size = s.bid_buyer_envelope_len ∧ s.bid_provider_envelope_size = s.bid_provider_envelope_len

/-- Property: time_windows_strictly_increasing. -/
def time_windows_strictly_increasing (s : State) : Prop :=
  s.rfp_status ≠ 0 → s.rfp_bid_open_at < s.rfp_bid_close_at ∧ s.rfp_bid_close_at < s.rfp_reveal_close_at

/-- Property: contract_value_set_on_award. -/
def contract_value_set_on_award (s : State) : Prop :=
  (s.rfp_status = 4 ∨ s.rfp_status = 5 ∨ s.rfp_status = 6 ∨ s.rfp_status = 7) → s.rfp_contract_value > 0

/-- Property: escrow_locks_contract_value. -/
def escrow_locks_contract_value (s : State) : Prop :=
  s.escrow_initialized = 1 → s.escrow_total_locked = s.rfp_contract_value

/-- Property: fee_bps_bounded. -/
def fee_bps_bounded (s : State) : Prop :=
  s.rfp_fee_bps ≤ 10000

/-- Property: rfp_buyer_immutable_after_open. -/
def rfp_buyer_immutable_after_open (s : State) : Prop :=
  (s.rfp_status ≠ 0 ∧ s.rfp_status ≠ 1) → (s.rfp_status ≥ 1)

/-- Property: treasury_initialized_after_init. -/
def treasury_initialized_after_init (s : State) : Prop :=
  s.treasury_initialized ≤ 1

/-- Property: bid_payout_chain_solana_only. -/
def bid_payout_chain_solana_only (s : State) : Prop :=
  s.bid_status ≠ 0 → s.bid_payout_chain = 0

end Tender
