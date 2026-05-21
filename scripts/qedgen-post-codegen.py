#!/usr/bin/env python3
"""
Post-codegen patches for qedgen v2.22+ generated artifacts.

Two patches, both workarounds for documented qedgen feature gaps (not bugs):

  1. mul_div_floor_u128 / mul_div_ceil_u128 → as u64 narrow.
     qedspec amounts are U64; the mul_div helpers return u128 because the
     intermediate `a * b` can overflow u64. Spec writes
         let fee = mul_div_floor(total, fee_bps, BPS_DENOMINATOR)
         let to_provider = total - fee
     which lowers to `let fee = mul_div_floor_u128(...)` (returns u128) then
     `let to_provider = total - fee` (u64 - u128 — does not typecheck).
     The mathematical result is bounded by `total` so the cast is safe.
     Tracked upstream as "qedspec needs `let X : U64 = ...` typed-let-binding
     syntax to drive the narrow in codegen."

  2. State-init bounds (kani::assume).
     Kani's symbolic state init binds every field to `kani::any()`, so
     time / accumulator / counter fields get worst-case values
     (i64::MAX, u64::MAX, etc.) which either overflow harmless symbolic
     arithmetic OR make implications vacuous OR explode the CBMC formula.
     Tracked upstream as "qedspec needs a `bounds {}` block (or extend
     `property X preserved_by all` propagation into effect / rejection
     harness preambles, not just preservation)."

Run after every `qedgen codegen --spec tender.qedspec --kani` (and
`--proptest` if proptest is regen'd in the same invocation). Idempotent:
re-running on already-patched output is a no-op for the narrow patch and
a re-application that produces the same result for the bounds patch.

Usage:
    python3 scripts/qedgen-post-codegen.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
KANI_AUTO = REPO_ROOT / "programs/tender/tests/kani_auto.rs"
PROPTEST = REPO_ROOT / "programs/tender/tests/proptest.rs"


# ── Patch 1: mul_div_floor_u128 / mul_div_ceil_u128 → as u64 narrow ─────────

# Pattern: `let NAME = mul_div_(floor|ceil)_u128(...);`
# Becomes:  `let NAME = (mul_div_..._u128(...)) as u64;`
# Idempotent: already-narrowed expressions have `... as u64;` and the regex
# does not match those.
MUL_DIV_NARROW = re.compile(
    r"let (\w+) = (mul_div_(?:floor|ceil)_u128\([^;]+\));"
)


def apply_mul_div_narrow(src: str) -> tuple[str, int]:
    """Return (new_src, count_of_replacements)."""
    new = MUL_DIV_NARROW.sub(r"let \1 = (\2) as u64;", src)
    count = len(MUL_DIV_NARROW.findall(src))
    return new, count


# ── Patch 2: state-init bounds via kani::assume ─────────────────────────────

# Field sets bounded at every `let mut s = State { ... };` site.

# i64 timestamp / deadline / *_at fields — bounded to a realistic unix-time
# upper bound (~year 2033). Window-secs fields (rfp_*_secs) and milestone
# duration arrays are bounded separately because they have their own ceiling
# (MAX_WINDOW_SECS in tender::state::rfp.rs, enforced by program require!).
TIME_FIELDS = [
    "now",
    "rfp_bid_open_at",
    "rfp_bid_close_at",
    "rfp_reveal_close_at",
    "rfp_created_at",
    "rfp_funding_deadline",
    "bid_bid_close_at",
    "bid_submitted_at",
    "milestone_started_at",
    "milestone_submitted_at",
    "milestone_review_deadline",
    "milestone_disputed_at",
    "milestone_dispute_deadline",
    "milestone_delivery_deadline",
    "escrow_funded_at",
    "buyer_rep_last_updated",
    "provider_rep_last_updated",
    "main_buyer_rep_last_updated",
    "main_provider_rep_last_updated",
    "win_receipt_attested_at",
]

# u64 accumulator fields — bounded to 1e15 (well below u64::MAX) to keep
# symbolic state from picking saturating-add fixpoints that would mask real
# overflow conditions further down the verification.
U64_ACCUMULATORS = [
    "milestone_amount",
    "rfp_contract_value",
    "escrow_total_locked",
    "escrow_total_released",
    "escrow_total_refunded",
    "treasury_total_collected",
    "buyer_rep_total_locked_usdc",
    "buyer_rep_total_released_usdc",
    "buyer_rep_total_refunded_usdc",
    "provider_rep_total_won_usdc",
    "provider_rep_total_earned_usdc",
    "provider_rep_total_disputed_usdc",
    "main_buyer_rep_total_locked_usdc",
    "main_buyer_rep_total_released_usdc",
    "main_buyer_rep_total_refunded_usdc",
    "main_provider_rep_total_won_usdc",
    "main_provider_rep_total_earned_usdc",
    "main_provider_rep_total_disputed_usdc",
]

# u32 counter fields — bounded to 1e8 to keep symbolic add+saturate
# behavior tractable.
U32_COUNTERS = [
    "buyer_rep_total_rfps",
    "buyer_rep_funded_rfps",
    "buyer_rep_completed_rfps",
    "buyer_rep_ghosted_rfps",
    "buyer_rep_disputed_milestones",
    "buyer_rep_cancelled_milestones",
    "provider_rep_total_wins",
    "provider_rep_completed_projects",
    "provider_rep_disputed_milestones",
    "provider_rep_abandoned_projects",
    "provider_rep_late_milestones",
    "main_buyer_rep_total_rfps",
    "main_buyer_rep_funded_rfps",
    "main_buyer_rep_completed_rfps",
    "main_buyer_rep_ghosted_rfps",
    "main_buyer_rep_disputed_milestones",
    "main_buyer_rep_cancelled_milestones",
    "main_provider_rep_total_wins",
    "main_provider_rep_completed_projects",
    "main_provider_rep_disputed_milestones",
    "main_provider_rep_abandoned_projects",
    "main_provider_rep_late_milestones",
    "rfp_bid_count",
]

TIME_UB = "2_000_000_000"  # year 2033 in unix seconds — comfortable headroom
U64_UB = "1_000_000_000_000_000"  # 10^15
U32_UB = "100_000_000"  # 10^8
MS_DURATION_UB = "1_000_000_000"  # i64; same scale as windows
MS_DURATIONS = "rfp_milestone_durations_secs"  # [i64; 8]


def build_bounds_block() -> str:
    """Build the kani::assume block injected after every State init."""
    lines = []
    for f in TIME_FIELDS:
        lines.append(f"    kani::assume(s.{f} >= 0 && s.{f} < {TIME_UB});")
    for f in U64_ACCUMULATORS:
        lines.append(f"    kani::assume(s.{f} < {U64_UB});")
    for f in U32_COUNTERS:
        lines.append(f"    kani::assume(s.{f} < {U32_UB});")
    for i in range(8):
        lines.append(
            f"    kani::assume(s.{MS_DURATIONS}[{i}] >= 0 && "
            f"s.{MS_DURATIONS}[{i}] < {MS_DURATION_UB});"
        )
    return "\n".join(lines)


# Match a complete `let mut s = State { ... };` block. Non-greedy on the
# body so adjacent blocks don't get merged.
STATE_INIT = re.compile(r"(    let mut s = State \{[^}]*    \};)", re.DOTALL)


def apply_state_init_bounds(src: str) -> tuple[str, int]:
    """Append the bounds block after every State init. Idempotent — if the
    bounds block already follows the init, the regex still matches and
    substitution produces identical output."""
    bounds = build_bounds_block()
    new = STATE_INIT.sub(
        lambda m: (
            m.group(1) if (m.group(1) + "\n" + bounds) in src
            else m.group(1) + "\n" + bounds
        ),
        src,
    )
    # Re-evaluate without the conditional — simpler: just inject and dedupe.
    new = STATE_INIT.sub(lambda m: m.group(1) + "\n" + bounds, src)
    # Idempotency check: collapse doubled bounds blocks if re-run.
    doubled = bounds + "\n" + bounds
    while doubled in new:
        new = new.replace(doubled, bounds)
    count = len(STATE_INIT.findall(src))
    return new, count


# ── Driver ───────────────────────────────────────────────────────────────────


def patch_file(path: Path, *, apply_bounds: bool) -> None:
    if not path.exists():
        print(f"  skip {path.relative_to(REPO_ROOT)} — not present")
        return
    src = path.read_text()
    new, narrow_count = apply_mul_div_narrow(src)
    bounds_count = 0
    if apply_bounds:
        new, bounds_count = apply_state_init_bounds(new)
    if new == src:
        print(f"  noop {path.relative_to(REPO_ROOT)}")
        return
    path.write_text(new)
    msg = [f"patch {path.relative_to(REPO_ROOT)}"]
    if narrow_count:
        msg.append(f"narrow ×{narrow_count}")
    if bounds_count:
        msg.append(f"bounds ×{bounds_count}")
    print(f"  {' | '.join(msg)}")


def main() -> int:
    print("qedgen post-codegen patches")
    print(f"  repo: {REPO_ROOT}")
    patch_file(KANI_AUTO, apply_bounds=True)
    patch_file(PROPTEST, apply_bounds=False)  # proptest uses runtime arbitrary
    return 0


if __name__ == "__main__":
    sys.exit(main())
