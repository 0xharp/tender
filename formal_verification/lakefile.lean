import Lake
open Lake DSL

package tenderProofs

require qedgenSupport from
  "./lean_solana"

-- Mathlib-dependent slice; pulls in mathlib transitively. Spec.lean
-- imports Mathlib.Algebra.BigOperators.Fin + QEDGenMathlib.IndexedState,
-- so we depend on both base + mathlib slices.
require qedgenSupportMathlib from
  "./lean_solana_mathlib"

@[default_target]
lean_lib TenderSpec where
  roots := #[`Spec, `Proofs]
