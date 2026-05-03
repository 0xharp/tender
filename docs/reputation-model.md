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

## Privacy semantics for the provider rep

In default-mode RFPs (bid contents private, bidder identity public) the bid
signer IS the main wallet, so reputation keys directly to it. In private-bidder
mode (bid contents + identity private) the bid is signed by an ephemeral wallet
but the encrypted envelope carries the main wallet plus a binding signature.
At award time `select_bid` verifies the binding signature on-chain
(Ed25519SigVerify precompile) and records `winner_provider = main wallet` on
the RFP. Every subsequent reputation update keys off `rfp.winner_provider`,
so reputation always lands on the bidder's main wallet — even when that
wallet was hidden until award.

Losing bidders' main wallets stay anonymous forever (their envelopes are never
decrypted by anyone but themselves). See [privacy-model](/docs/privacy-model)
for the full mechanism.

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
| `abandoned_projects` | u32 | (Reserved for future provider-walks ix; currently always 0) | — |
| `late_milestones` | u32 | Milestones provider missed the per-milestone delivery deadline on | `cancel_late_milestone` |
| `total_won_usdc` | u64 | Sum of `contract_value` across all wins (gross USDC base units) | `select_bid` |
| `total_earned_usdc` | u64 | Sum NET-of-fee that landed in provider's payout wallet (incl. cancel-penalty payouts) | `accept_milestone`, `auto_release_milestone`, `resolve_dispute`, `dispute_default_split`, `cancel_with_penalty` |
| `total_disputed_usdc` | u64 | Sum of milestone amounts that hit dispute path (regardless of how dispute closed) | `reject_milestone` (set at dispute-OPEN time) |
| `last_updated` | i64 | Unix seconds; bumped on every write | every ix above |
| `bump` | u8 | PDA bump | init only |

### Semantic note: `abandoned_projects`

Field exists in the schema for a future "provider walks the project" ix
(separate from the dispute path), but no ix currently writes to it. Today, a
provider that misses delivery is captured by `late_milestones` via
`cancel_late_milestone`. A provider that initiates a dispute on their own work
goes through `propose_dispute_split` → reputation writes happen via the
resolve/default-split paths. UI should treat `abandoned_projects` as an unused
field for now.

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

## Things this model does NOT track

By design — these are explicit non-features:

- **Qualitative ratings (1-5 stars).** Out of scope today; can be added
  later via a `buyer_attestation` ix.
- **Per-category breakdown** (audits vs design vs marketing). Reputation is
  global across categories. Categories live on the RFP, not on the rep account.
- **Recency weighting / decay.** All counters are lifetime; no half-life.
- **Verified counterparty identity** (KYC/KYB). Pseudonymous tier 0 only.
- **Cross-program portability.** Reputation lives only on tendr.bid's program.
  A v2 could add an attestation ix to mirror to a generic on-chain registry.
- **Provider's bid count, win rate.** Bid count comes from
  `getProgramAccounts(BidCommit + provider memcmp)` — not stored on rep
  account because it would need updating on every commit/withdraw.

## Recovering from past bugs

If a deployed program had a reputation update gap (as happened during the
2026-05-03 audit), affected counters can't be retroactively repaired without
either (a) writing a one-off "rep migration" ix that recomputes from on-chain
events, or (b) accepting the historical undercount. We chose (b) — the gaps
were caught before any RFP completed end-to-end on devnet, so no real
reputation data was lost. Future deployments that change rep semantics
should ship a migration ix or clearly document the semantic break.
