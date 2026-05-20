import Spec

/-!
# Tender — Proof Bodies for Headline Invariants

Each theorem here states "transition X preserves property P". Proofs
operate on the auto-generated `XTransition (s : State) ... : Option State`
functions in `Spec.lean` (regenerated from `tender.qedspec` by
`qedgen codegen --lean`).

## What's proved here

Currently 10 hand-written Lean proofs. Kani harnesses verify the same
properties bounded; these add the unbounded "for all states" guarantee
on the Lean model.

| Theorem | Property | Transition |
| --- | --- | --- |
| `treasury_monotonic_universal` | `treasury_monotonic` | universal |
| `rfp_create_preserves_fee_bps_bounded` | `fee_bps_bounded` | `rfp_create` |
| `finalize_bid_preserves_bid_finalize_requires_committed_envelopes` | `bid_finalize_requires_committed_envelopes` | `finalize_bid` |
| `fund_project_preserves_escrow_locks_contract_value` | `escrow_locks_contract_value` | `fund_project` |
| `fund_project_preserves_escrow_conservation` | `escrow_conservation` | `fund_project` |
| `cancel_with_notice_preserves_escrow_conservation` | `escrow_conservation` | `cancel_with_notice` |
| `cancel_with_penalty_preserves_escrow_conservation` | `escrow_conservation` | `cancel_with_penalty` |
| `cancel_late_milestone_preserves_escrow_conservation` | `escrow_conservation` | `cancel_late_milestone` |
| `accept_milestone_preserves_escrow_conservation` | `escrow_conservation` | `accept_milestone` |
| `auto_release_milestone_preserves_escrow_conservation` | `escrow_conservation` | `auto_release_milestone` |
| `dispute_default_split_preserves_escrow_conservation` | `escrow_conservation` | `dispute_default_split` |
| `select_bid_preserves_contract_value_set_on_award` | `contract_value_set_on_award` | `select_bid` |

The escrow_conservation cancel/accept/release/dispute proofs all follow
the same shape: those transitions' post-states do not mutate
`escrow_total_locked/_released/_refunded` — funds movement happens via
the on-chain TransferChecked CPI which the spec models as out-of-scope
(the invariant is about the SPL accounting; the spec proves the gating
guard `locked ≥ released + refunded + amount` is respected pre-transition).
The Rust handler's actual transfer + counter update is covered by the
Kani harnesses (bounded) and proptest (randomized).
-/

namespace Tender

open QEDGen.Solana

-- ─────────────────────────────────────────────────────────────────────────
-- 1. treasury_monotonic — universal
-- ─────────────────────────────────────────────────────────────────────────

theorem treasury_monotonic_universal (s : State) : treasury_monotonic s := by
  unfold treasury_monotonic
  exact Nat.zero_le _

-- ─────────────────────────────────────────────────────────────────────────
-- 2. fee_bps_bounded — after rfp_create
-- ─────────────────────────────────────────────────────────────────────────

theorem rfp_create_preserves_fee_bps_bounded
    (s : State) (signer : Pubkey)
    (rfp_nonce buyer_encryption_pubkey title_hash category : Nat)
    (bid_open_at bid_close_at reveal_close_at : Int)
    (bidder_visibility buyer_visibility : Nat)
    (reserve_price_commitment : Nat)
    (funding_window_secs review_window_secs dispute_cooloff_secs
      cancel_notice_secs : Int)
    (max_iterations : Nat) (s' : State) :
    rfp_createTransition s signer rfp_nonce buyer_encryption_pubkey title_hash
        category bid_open_at bid_close_at reveal_close_at bidder_visibility
        buyer_visibility reserve_price_commitment funding_window_secs
        review_window_secs dispute_cooloff_secs cancel_notice_secs max_iterations
      = some s' → fee_bps_bounded s' := by
  unfold rfp_createTransition fee_bps_bounded
  split_ifs with h
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    -- After rfp_create the post-state has rfp_fee_bps := 250.
    -- The record field selector reduces to 250, then 250 ≤ 10000 is decide-able.
    simp
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 3. bid_finalize_requires_committed_envelopes — guard direct
-- ─────────────────────────────────────────────────────────────────────────

theorem finalize_bid_preserves_bid_finalize_requires_committed_envelopes
    (s : State) (signer : Pubkey) (s' : State) :
    finalize_bidTransition s signer = some s' →
    bid_finalize_requires_committed_envelopes s' := by
  unfold finalize_bidTransition bid_finalize_requires_committed_envelopes
  split_ifs with hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro _hstatus
    -- After finalize_bid: bid_status := 1; envelope sizes/lens unchanged.
    -- The guard requires sizes = lens, which gives the post-condition
    -- directly.
    refine ⟨?_, ?_⟩
    · exact hguard.2.2.1
    · exact hguard.2.2.2
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 4. escrow_locks_contract_value preserved by fund_project
-- ─────────────────────────────────────────────────────────────────────────

theorem fund_project_preserves_escrow_locks_contract_value
    (s : State) (signer : Pubkey) (s' : State) :
    fund_projectTransition s signer = some s' →
    escrow_locks_contract_value s' := by
  unfold fund_projectTransition escrow_locks_contract_value
  split_ifs with hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro _hinit
    rfl
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 5. escrow_conservation preserved by fund_project
-- ─────────────────────────────────────────────────────────────────────────

theorem fund_project_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (s' : State) :
    escrow_conservation s →
    fund_projectTransition s signer = some s' →
    escrow_conservation s' := by
  intro _hpre
  unfold fund_projectTransition escrow_conservation
  split_ifs with hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro _hinit
    -- After fund_project: released' = 0, refunded' = 0, so 0 + 0 ≤ locked'
    -- which holds for any Nat locked'.
    simp
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 6. escrow_conservation preserved by cancel_with_notice
-- ─────────────────────────────────────────────────────────────────────────

theorem cancel_with_notice_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    cancel_with_noticeTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold cancel_with_noticeTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    -- The transition leaves escrow_total_* unchanged; the SPL TransferChecked
    -- happens out-of-band. Post-state property collapses to pre-state property.
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 7. escrow_conservation preserved by cancel_with_penalty (same shape)
-- ─────────────────────────────────────────────────────────────────────────

theorem cancel_with_penalty_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    cancel_with_penaltyTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold cancel_with_penaltyTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 8. escrow_conservation preserved by cancel_late_milestone (same shape)
-- ─────────────────────────────────────────────────────────────────────────

theorem cancel_late_milestone_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    cancel_late_milestoneTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold cancel_late_milestoneTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 9. escrow_conservation preserved by accept_milestone (same shape)
-- ─────────────────────────────────────────────────────────────────────────

theorem accept_milestone_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    accept_milestoneTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold accept_milestoneTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 10. escrow_conservation preserved by auto_release_milestone (same shape)
-- ─────────────────────────────────────────────────────────────────────────

theorem auto_release_milestone_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    auto_release_milestoneTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold auto_release_milestoneTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 11. escrow_conservation preserved by dispute_default_split (same shape)
-- ─────────────────────────────────────────────────────────────────────────

theorem dispute_default_split_preserves_escrow_conservation
    (s : State) (signer : Pubkey) (milestone_index : Nat) (s' : State) :
    escrow_conservation s →
    dispute_default_splitTransition s signer milestone_index = some s' →
    escrow_conservation s' := by
  intro hpre
  unfold escrow_conservation at hpre
  unfold dispute_default_splitTransition escrow_conservation
  split_ifs with _hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro hinit
    exact hpre hinit
  · intro hcontra
    cases hcontra

-- ─────────────────────────────────────────────────────────────────────────
-- 12. contract_value_set_on_award preserved by select_bid
--     (was blocked on qedgen v2.18 Lean codegen — fixed in v2.22.)
-- ─────────────────────────────────────────────────────────────────────────

theorem select_bid_preserves_contract_value_set_on_award
    (s : State) (signer : Pubkey)
    (winner_provider contract_value milestone_count
      milestone_amounts_sum milestone_amounts_all_positive : Nat)
    (s' : State) :
    select_bidTransition s signer winner_provider contract_value milestone_count
        milestone_amounts_sum milestone_amounts_all_positive = some s' →
    contract_value_set_on_award s' := by
  unfold select_bidTransition contract_value_set_on_award
  split_ifs with hguard
  · intro heq
    simp only [Option.some.injEq] at heq
    subst heq
    intro _hstatus
    -- Guard ensures `contract_value > 0`. Post-state sets
    -- `rfp_contract_value := contract_value`. Property: rfp_contract_value > 0.
    exact hguard.2.2.2.1
  · intro hcontra
    cases hcontra

end Tender
