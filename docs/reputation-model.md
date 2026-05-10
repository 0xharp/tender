# On-chain reputation

> Authoritative reference for what every reputation field means and which
> instruction touches it. Sourced from `programs/tender/src/state/reputation.rs`
> and verified against every settlement-path handler.

## Why on-chain reputation?

A buyer or provider's track record on tendr.bid is durable, portable, and
permissionless to read. Anyone can query the chain and rank counterparties;
nothing depends on this app being online. Two PDAs, one per role:

| Account | Seeds | One per |
|---|---|---|
| `BuyerReputation` | `["buyer_rep", buyer]` | wallet that has ever awarded an RFP |
| `ProviderReputation` | `["provider_rep", main_wallet]` | wallet that has ever won an RFP |

Both PDAs are created on first use (`init_if_needed` from `select_bid`) and
mutated by every subsequent ix that touches their lifecycle. Reads don't need
any of this app's code — `getProgramAccounts` + the codama decoder is enough.

## Privacy semantics across the four privacy modes

Reputation accrual differs based on the per-RFP **bidder privacy** + **buyer privacy** axes (see [privacy-model](/docs/privacy-model) for the mechanism):

| Mode | `rfp.buyer` | `bid.provider` (winner) | BuyerReputation accrues to | ProviderReputation accrues to |
|---|---|---|---|---|
| Public buyer + public bidder | Buyer's main wallet | Provider's main wallet | Main wallet directly | Main wallet directly |
| Public buyer + private bidder | Buyer's main wallet | Bidder ephemeral | Main wallet directly | Bidder eph PDA, until merged via `attest_win` |
| Private buyer + public bidder | Buyer ephemeral | Provider's main wallet | Buyer eph PDA, until merged via `attest_buyer_history` | Main wallet directly |
| Private buyer + private bidder (fully sealed) | Buyer ephemeral | Bidder ephemeral | Buyer eph PDA, until merged via `attest_buyer_history` | Bidder eph PDA, until merged via `attest_win` |

Both ephemerals are HD-derived from the main wallet's master keychain seed (one signature per session unlocks the entire derivation tree). The merge ix on each side is symmetric: idempotent, gated to RFP status `Completed`, verifies an Ed25519 binding signature proving the claiming main wallet is the same one that derived the ephemeral, and atomically copies every counter from the eph PDA into the main-wallet PDA.

Losing bidders' main wallets stay anonymous **forever** — their envelopes are never decrypted in any context that publishes the main wallet on chain, and no claim ix ever runs against them. See [privacy-model](/docs/privacy-model) § "Claim-based reputation merge" for the full mechanism.

## BuyerReputation fields

| Field | Type | What it counts | Set by |
|---|---|---|---|
| `buyer` | Pubkey | Owner wallet (zero pre-init) | `select_bid` (first award) |
| `total_rfps` | u32 | **Awarded RFPs** (NOT created RFPs - see semantic note below) | `select_bid` |
| `funded_rfps` | u32 | Awards that actually got funded (escrow locked) | `fund_project` |
| `completed_rfps` | u32 | Funded RFPs that drained the escrow with **at least some value released to the provider**. Projects where every milestone was refunded (no work delivered) flip to `RfpStatus::Cancelled` instead and don't tick this counter — see [lifecycle](/docs/lifecycle) § "Completed vs Cancelled". | `accept_milestone`, `auto_release_milestone`, `resolve_dispute`, `dispute_default_split` |
| `ghosted_rfps` | u32 | Awarded an RFP but never funded within `funding_window_secs` | `mark_buyer_ghosted` (permissionless after deadline) |
| `disputed_milestones` | u32 | Milestones the buyer rejected into dispute path | `reject_milestone` |
| `cancelled_milestones` | u32 | Milestones cancelled mid-flight (cancel-with-penalty only — cancel-with-notice is no-fault) | `cancel_with_penalty` |
| `total_locked_usdc` | u64 | Sum of `contract_value` across all awards (gross USDC base units) | `select_bid` |
| `total_released_usdc` | u64 | Sum released to providers (regular accepts, auto-releases, dispute splits, cancel-penalty payouts) | `accept_milestone`, `auto_release_milestone`, `resolve_dispute`, `dispute_default_split`, `cancel_with_penalty` |
| `total_refunded_usdc` | u64 | Sum returned via cancellations + dispute refunds | `cancel_with_notice`, `cancel_with_penalty`, `cancel_late_milestone`, `resolve_dispute`, `dispute_default_split` |
| `last_updated` | i64 | Unix seconds; bumped on every write | every ix above |
| `bump` | u8 | PDA bump | init only |

### Semantic note: `total_rfps`

The field name suggests "all RFPs the buyer ever created," but it's actually
incremented at `select_bid` time — so it counts **awarded RFPs**. RFPs that
were created but received no bids (or received bids but were never awarded)
don't bump this counter. To count "all RFPs ever created" at the UI layer, use
`getProgramAccounts(rfp_discriminator + buyer_memcmp)` instead of reading this
field.

Reason for the design: incrementing at create-time would force `BuyerReputation`
to be `init_if_needed` inside `rfp_create`, which would add ~0.002 SOL rent
every time a new buyer creates their first RFP. Lazier init at first award
(when there's already an account-creation cost for the milestone PDAs) is
cheaper for the common-case "create-and-experiment" path.

## ProviderReputation fields

| Field | Type | What it counts | Set by |
|---|---|---|---|
| `provider` | Pubkey | Main wallet (zero pre-init) | `select_bid` (first win) |
| `total_wins` | u32 | RFPs the provider was awarded | `select_bid` |
| `completed_projects` | u32 | Won RFPs that drained the escrow with **at least some value released to the provider**. Projects where every milestone was refunded (RFP terminates as `Cancelled`) don't tick this counter. | `accept_milestone`, `auto_release_milestone`, `resolve_dispute`, `dispute_default_split` |
| `disputed_milestones` | u32 | Milestones that hit the dispute path | `reject_milestone` |
| `late_milestones` | u32 | Milestones provider missed the per-milestone delivery deadline on | `cancel_late_milestone` |
| `total_won_usdc` | u64 | Sum of `contract_value` across all wins (gross USDC base units) | `select_bid` |
| `total_earned_usdc` | u64 | Sum NET-of-fee that landed in provider's payout wallet (incl. cancel-penalty payouts) | `accept_milestone`, `auto_release_milestone`, `resolve_dispute`, `dispute_default_split`, `cancel_with_penalty` |
| `total_disputed_usdc` | u64 | Sum of milestone amounts that hit dispute path (regardless of how dispute closed) | `reject_milestone` (set at dispute-OPEN time) |
| `last_updated` | i64 | Unix seconds; bumped on every write | every ix above |
| `bump` | u8 | PDA bump | init only |

### Semantic note: `total_disputed_usdc`

Bumped at **dispute-OPEN time** (`reject_milestone`), not at dispute-CLOSE
time. This is intentional: the field's meaning is "milestone amounts that
entered the dispute path," and that fact is decided when the milestone is
rejected — independent of whether the dispute resolves via mutual agreement
(`resolve_dispute`) or by lapse (`dispute_default_split`). Using dispute-open
timing gives a consistent metric across both close paths.

## Truth table by instruction

What each settlement-path ix writes. Empty cell = no write.

### Counters

| Ix | Buyer side | Provider side |
|---|---|---|
| `select_bid` | `total_rfps += 1` | `total_wins += 1` |
| `fund_project` | `funded_rfps += 1` | — |
| `accept_milestone` (last milestone) | `completed_rfps += 1` | `completed_projects += 1` |
| `auto_release_milestone` (last milestone) | `completed_rfps += 1` | `completed_projects += 1` |
| `request_changes` | — | — |
| `reject_milestone` | `disputed_milestones += 1` | `disputed_milestones += 1` |
| `resolve_dispute` (settles project) | `completed_rfps += 1` | `completed_projects += 1` |
| `dispute_default_split` (settles project) | `completed_rfps += 1` | `completed_projects += 1` |
| `cancel_with_notice` | — | — |
| `cancel_with_penalty` | `cancelled_milestones += 1` | — |
| `cancel_late_milestone` | — | `late_milestones += 1` |
| `mark_buyer_ghosted` | `ghosted_rfps += 1` | — |

### Amounts (USDC base units)

| Ix | `buyer.total_locked` | `buyer.total_released` | `buyer.total_refunded` | `provider.total_won` | `provider.total_earned` | `provider.total_disputed` |
|---|---|---|---|---|---|---|
| `select_bid` | `+= contract_value` |  |  | `+= contract_value` |  |  |
| `fund_project` |  |  |  |  |  |  |
| `accept_milestone` |  | `+= milestone.amount` |  |  | `+= milestone.amount * (1 - fee_bps/10000)` |  |
| `auto_release_milestone` |  | `+= milestone.amount` |  |  | `+= milestone.amount * (1 - fee_bps/10000)` |  |
| `reject_milestone` |  |  |  |  |  | `+= milestone.amount` |
| `resolve_dispute` |  | `+= split_to_provider` | `+= refund_to_buyer` |  | `+= split_to_provider * (1 - fee_bps/10000)` |  |
| `dispute_default_split` |  | `+= milestone.amount / 2` | `+= milestone.amount / 2` |  | `+= (amount/2) * (1 - fee_bps/10000)` |  |
| `cancel_with_notice` |  |  | `+= milestone.amount` |  |  |  |
| `cancel_with_penalty` |  | `+= penalty (50%)` | `+= refund (50%)` |  | `+= penalty (50%)` |  |
| `cancel_late_milestone` |  |  | `+= milestone.amount` |  |  |  |
| `mark_buyer_ghosted` |  |  |  |  |  |  |

## Derived metrics for UI

The fields above are the on-chain truth; the UI can compute richer metrics on
top:

- **Buyer follow-through rate** = `funded_rfps / total_rfps` — what fraction of
  awards actually got funded. A buyer who consistently awards but never funds is
  flagged by both this ratio AND a high `ghosted_rfps`.
- **Buyer completion rate** = `completed_rfps / funded_rfps` — what fraction of
  funded projects ran to completion vs got cancelled mid-flight.
- **Buyer dispute rate** = `disputed_milestones / (completed_rfps + disputed_milestones)`
  — rough signal for how often this buyer rejects work.
- **Provider on-time rate** = 1 - `late_milestones / completed_projects` — how
  reliably the provider hits delivery deadlines (only meaningful with
  `completed_projects > 0`).
- **Provider dispute rate** = `disputed_milestones / (completed_projects +
  disputed_milestones)`.
- **Provider net take** = `total_earned_usdc / total_won_usdc` — typically
  ~0.975 for a well-behaved provider (only the platform fee shaved off);
  noticeably lower means lots of disputes/cancellations cut their effective
  earnings.

UI should hide ratios when the denominator is < some small threshold (e.g.
< 3) so a single bad outcome doesn't make a new account look catastrophic.

## Failure-mode coverage matrix

Confirms every settlement-path ix updates BOTH sides' rep correctly. (Updated
2026-05-03 after the audit pass that found 4 gaps and patched them.)

| Settlement ix | Buyer rep updated? | Provider rep updated? |
|---|---|---|
| `accept_milestone` | ✓ amount + completion | ✓ amount + completion |
| `auto_release_milestone` | ✓ amount + completion (was missing pre-fix) | ✓ amount + completion |
| `cancel_with_notice` | ✓ refund amount | — (no-fault) |
| `cancel_with_penalty` | ✓ counter + amounts | ✓ amount (penalty as earnings) |
| `cancel_late_milestone` | ✓ refund amount | ✓ counter (late) |
| `reject_milestone` | ✓ counter | ✓ counter + disputed amount |
| `resolve_dispute` | ✓ amounts + completion | ✓ amount + completion |
| `dispute_default_split` | ✓ amounts + completion (was missing pre-fix) | ✓ amount + completion (was missing pre-fix) |
| `mark_buyer_ghosted` | ✓ counter | — |

## Claim-based merge from ephemeral to main wallet

Both privacy axes (anonymous buyer, anonymous bidder) accrue reputation on a
**per-ephemeral PDA** during the project's lifetime. Two symmetric ix merge
those counters into the main wallet's rep when the user is ready.

### `attest_buyer_history` (buyer side)

Called by the buyer's main wallet after a private-buyer RFP completes. Atomically
copies every counter from the buyer ephemeral's BuyerReputation PDA into the
main wallet's BuyerReputation PDA.

| Aspect | Detail |
|---|---|
| Caller | Main wallet (signer + fee payer + rent payer for `init_if_needed` of main rep PDA) |
| Source PDA | `[b"buyer_rep", buyer_eph]` — read-only |
| Dest PDA | `[b"buyer_rep", main_wallet]` — `init_if_needed`, mut |
| Idempotency | `rfp.buyer_attested: bool` flips true; second call reverts |
| Status gate | `rfp.status == Completed` only |
| Verification | Ed25519SigVerify ix at index 0 proves main wallet signed `tender-buyer-eph-binding-v1 || program_id || rfp_pda || main_wallet || buyer_eph` |

Counters merged: `total_rfps`, `funded_rfps`, `completed_rfps`, `ghosted_rfps`,
`disputed_milestones`, `cancelled_milestones`, `total_locked_usdc`,
`total_released_usdc`, `total_refunded_usdc`. `last_updated` bumps on the
main wallet's rep.

### `attest_win` (provider side)

Called by the provider's main wallet after a private-bidder win on a completed
RFP. Atomically copies every counter from the bidder ephemeral's
ProviderReputation PDA into the main wallet's ProviderReputation PDA.

| Aspect | Detail |
|---|---|
| Caller | Main wallet (signer + fee payer + rent payer for `init_if_needed` of main rep PDA) |
| Source PDA | `[b"provider_rep", bidder_eph]` — read-only |
| Dest PDA | `[b"provider_rep", main_wallet]` — `init_if_needed`, mut |
| Idempotency | `bid.winner_attested: bool` flips true; second call reverts |
| Status gate | `rfp.status == Completed` AND `bid.status == Selected` AND `rfp.bidder_visibility == BuyerOnly` |
| Verification | Ed25519SigVerify ix at index 0 proves main wallet signed `tender-bid-binding-v1 || program_id || rfp_pda || bid_pda || main_wallet` (the same binding signature cached on the bid envelope at submission time — no second wallet popup needed) |

Counters merged: `total_wins`, `completed_projects`, `disputed_milestones`,
`late_milestones`, `total_won_usdc`, `total_earned_usdc`,
`total_disputed_usdc`. `last_updated` bumps on the main wallet's rep.

### What the claim does NOT do

- It does NOT rewrite `rfp.buyer` or `bid.provider` on chain. Those stay as
  the ephemeral pubkey — surfacing the claimed RFP under the main wallet's
  profile RFP list would re-link them and defeat the privacy property the
  project ran under. The leaderboard filters known ephemerals out so they
  don't pollute the rankings even after their counters were copied.
- It does NOT touch loser state. Losing private bidders' main wallets stay
  anonymous regardless of whether the winner claims.
- It does NOT delete the source ephemeral PDA. The eph rep stays in place
  but is dead — its counters were already merged. Eph-rep-PDA-keyed leaderboard
  rows are filtered client-side via the `ephemeralBuyers` set construction
  (see `apps/web/app/leaderboard/page.tsx`).

### Public-mode wins skip the claim

When `rfp.bidder_visibility == Public`, the bid is signed by the provider's
main wallet directly, `bid.provider == main_wallet`, and reputation accrues
to the main wallet's PDA at every settlement-path ix without any extra
step. `attest_win` only applies to private-bidder mode. Same shape on the
buyer side: public-buyer RFPs accrue directly to `[b"buyer_rep", main_wallet]`
and don't need `attest_buyer_history`.

## Things this model does NOT track

By design — these are explicit non-features:

- **Qualitative ratings (1-5 stars).** Reputation is purely behavioral —
  what each side actually did with their counterparty's money and time, not
  how they felt about it. Stars are noisy, gameable, and add a rating-fatigue
  burden tendr.bid avoids.
- **Per-category breakdown** (audits vs design vs marketing). Reputation is
  global across categories. Categories live on the RFP, not on the rep account.
  Filtering reputation by category is a UI concern, not an on-chain one.
- **Recency weighting / decay.** All counters are lifetime; no half-life. UIs
  that want recency can derive it from the per-RFP `created_at` on the chain
  RFP accounts.
- **Verified counterparty identity** (KYC/KYB). Pseudonymous only — the
  on-chain registry IS the trust signal. SNS adds a recognizable display name
  on top (see [identity](/docs/identity)) without changing what's tracked.
- **Cross-program portability.** Reputation lives on tendr.bid's program.
  Other Solana programs can read it freely via `getProgramAccounts` + the
  codama decoder; nothing depends on this app being online.
- **Provider's bid count + win rate.** Bid count comes from
  `getProgramAccounts(BidCommit + provider memcmp)` — not stored on the rep
  account because it would need updating on every commit/withdraw, which
  would burn rent + CU on a derivable signal.
