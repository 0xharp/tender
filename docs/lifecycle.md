# RFP lifecycle

> What happens at each stage of an RFP, who can act, and what each action does. The lifecycle bar on every RFP detail page reflects this state machine exactly.

If you're after the user-facing summary of "what should I do next?", check the [FAQ](/docs/faq) or your `/me/projects` workbench (it surfaces the next concrete step for every project you're in). This doc is the reference: the full state machine, every action, every deadline.

---

## The happy path

A project moves through these stages in order. Each row says which action moves it forward, what the deadline is, and what you'll see in the UI.

| Stage | Buyer-side | Provider-side | Notable deadline |
|---|---|---|---|
| **Bidding** | Wait for bids to land. You CANNOT see bid contents — they're sealed. | Browse the RFP, submit a sealed bid. Withdraw if you change your mind. | `bid_close_at` — buyer chose this at create time. |
| **Reveal** | Decrypt all bids in your browser (one wallet signature). Optionally reveal your sealed reserve price. Pick a winner. | Wait. You can decrypt your own bid back any time. | `reveal_close_at` — buyer picked at create time, default a few hours after bid close. |
| **Awarded** | Lock the contract value in USDC escrow. | Wait for the buyer to fund. | `funding_deadline` — `select_bid` time + 3 days (default). After this, anyone can mark you ghosted. |
| **Funded** | Wait for the provider to start the first milestone. | Click "Start" on milestone 1 when you're actually beginning work. | None at this stage. |
| **In progress** | Review each submitted milestone: accept, request changes, or reject. | Submit each milestone when delivery-ready, optionally with a delivery note. Iterate on changes if requested. | Per-milestone `review_deadline` (auto-release if buyer goes silent) + `delivery_deadline` (provider committed in their bid). |
| **Completed** | Done. At least one milestone was released to the provider; project counts as a delivered project on both reputation cards. | Done. Your `completed_projects` rep counter ticks. | Terminal state. |

Most happy-path projects move through these in order without any of the alternative paths firing.

### `Completed` vs `Cancelled` — how the chain decides

When the escrow drains (`total_released + total_refunded ≥ total_locked`),
the program auto-flips to one of two terminal states based on whether
ANY value was released to the provider:

- `total_released > 0` → **`Completed`**. At least one milestone shipped.
  Both sides' `completed_projects` / `completed_rfps` rep counters tick.
  The UI may further qualify as "Project closed (partial delivery)" when
  some milestones were cancelled or settled by dispute, but the on-chain
  status stays `Completed` — it's still a project where work was delivered.
- `total_released == 0` → **`Cancelled`**. Every milestone was refunded
  (only possible via cancel-with-notice on Pending milestones or
  cancel-late-milestone on missed-deadline ones). No reputation credit on
  either side. UI shows "Project cancelled — no work delivered."

Why distinguish: a buyer who serially cancels every milestone before any
work shouldn't appear on chain as having "completed projects" — that
would corrupt the trust signal future providers rely on.

## Failure paths

What happens when things go sideways:

| State | Triggered by | What it means |
|---|---|---|
| `Cancelled` | Auto-set when every milestone was refunded (no value released) — see the "Completed vs Cancelled" section above. | Project ended without any work being delivered. Different from `Completed` so on-chain reputation can distinguish. |
| `GhostedByBuyer` | Anyone calls `mark_buyer_ghosted` after `funding_deadline` expires while the RFP is still in `Awarded` | The buyer awarded a winner but never funded. Buyer's `ghosted_rfps` counter increments on chain — visible to every future bidder. |
| `Disputed` | Buyer rejects a milestone submission | A milestone is in dispute. Cool-off + matching-split flow kicks in (see "Dispute" section below). |
| `Expired` | Anyone calls `expire_rfp` after `reveal_close_at` expires while the RFP is still in `Reveal`/`BidsClosed` | The buyer never picked a winner before the reveal window closed. Permissionless escape hatch — RFP becomes a terminal record so the dead "Award the winner" action stops surfacing. |

---

## Every action, in order

This is the full reference. Each subsection covers what one action does, who can call it, and what state transitions it triggers.

### Buyer creates the RFP

**`rfp_create`** (buyer)

Creates the on-chain RFP account with status `Open`. Sets bid windows, optional sealed reserve price (sha256 commitment), per-RFP windows (funding deadline, review window, dispute cool-off, cancel notice), and the platform fee rate locked at creation.

Milestone count is 0 here — milestones are part of each provider's bid, not the RFP itself. The buyer specifies a budget + scope; providers propose how to split it.

### Bidding closes

**`rfp_close_bidding`** (anyone, after `bid_close_at`)

`Open → Reveal`. Permissionless: usually the buyer triggers it, but a bot or any wallet can advance the RFP once the bid window has expired. This is also when the on-chain instruction `open_reveal_window` lets the buyer's wallet decrypt the bids inside the TEE.

### Buyer awards a winner

**`select_bid`** (buyer, before `reveal_close_at`)

`Reveal → Awarded`. Writes the winning bid PDA, the contract value, the milestone breakdown (amounts + delivery deadlines), and the funding deadline.

For private-bidder-mode RFPs, this transaction also includes an Ed25519 signature-verification instruction at index 0 that proves the winning provider's main wallet committed to the bid (see [privacy-model](/docs/privacy-model)). The verified main wallet gets recorded in the RFP's `winner_provider` field — that's the moment a private-mode winner becomes on-chain-linkable.

Provider's `total_won_usdc` reputation field bumps here.

### Reveal expired without an award (failure path)

**`expire_rfp`** (anyone, after `reveal_close_at`)

`Reveal/BidsClosed → Expired`. Permissionless escape hatch when the buyer
never picks a winner before the reveal window closes. Without this, the RFP
would be permanently stuck — `select_bid` reverts past the deadline, and
there'd be no clean terminal state for the UI to show. No funds or rent
move; the RFP just flips status so the dead "Award the winner" action
stops surfacing.

### Buyer ghosted (failure path)

**`mark_buyer_ghosted`** (anyone, after `funding_deadline`)

`Awarded → GhostedByBuyer`. Anyone can call this — typically the unhappy provider who didn't get funded. Buyer's `ghosted_rfps` counter increments. Provider receives no payout but is freed to bid on other RFPs.

### Buyer funds escrow

**`fund_project`** (buyer, before `funding_deadline`)

`Awarded → Funded`. Locks the full contract value in USDC into the escrow account + creates one milestone state account per milestone at the amounts the winning bid quoted.

### Provider starts a milestone

**`start_milestone`** (provider)

Milestone `Pending → Started`. Sets the milestone's delivery deadline (now + duration the provider committed in their bid). Sets the RFP's `active_milestone_index` so only one milestone can be in flight at a time.

Flips RFP `Funded → InProgress` on the very first start.

### Provider submits a milestone

**`submit_milestone`** (provider, when their active milestone is `Started`)

Milestone `Started → Submitted`. Sets the milestone's `review_deadline` (now + buyer's review window — default a few days, set at RFP creation). Slot stays active. The provider can attach an off-chain note with the on-chain submit (deliverable link, summary of what shipped).

### Buyer accepts a milestone

**`accept_milestone`** (buyer, milestone `Submitted`)

Milestone `Submitted → Released`. Releases the milestone amount from escrow: provider receives `amount × (1 - fee_bps/10_000)`, treasury receives the platform fee. Clears `active_milestone_index`. Auto-flips RFP to `Completed` when every milestone is in a terminal state.

### Auto-release (silence equals consent)

**`auto_release_milestone`** (anyone, after `review_deadline`)

Identical effect to `accept_milestone`. The provider can call this themselves if the buyer goes silent past the review window — silence equals consent.

### Buyer requests changes

**`request_changes`** (buyer, milestone `Submitted`, iteration count below cap)

Milestone reverts `Submitted → Started`. Iteration count increments. Slot stays active so the provider can iterate without bumping the active-milestone gate. The buyer can attach an off-chain note saying what needs to change.

Iteration cap is per-RFP (default 3). Past that, the buyer must accept, reject (escalate to dispute), or cancel.

### Buyer rejects a milestone (escalation)

**`reject_milestone`** (buyer, milestone `Submitted`)

Milestone `Submitted → Disputed`. Sets the dispute cool-off deadline (now + cool-off seconds, default 3 days). Flips the RFP `InProgress → Disputed`.

This is an escalation, not a cancel. The dispute flow either ends in a mutual on-chain split or the deliberately-unattractive 50/50 default after cool-off (see below).

### Both parties resolve the dispute

**`resolve_dispute`** (both parties post matching split proposals)

Milestone `Disputed → DisputeResolved`. Releases per the agreed split, with platform fee on the provider's portion. Clears active. RFP returns to `InProgress` or auto-flips to `Completed` if this was the last milestone.

The intent: buyer + provider settle off-platform (chat, call, whatever) and then both submit the same split as a proposed bps to the chain. The contract releases when both proposals match.

### Default 50/50 split (escape hatch)

**`dispute_default_split`** (anyone, after `dispute_deadline`)

Milestone `Disputed → DisputeDefault`. Hardcoded 50/50 split — half to provider as ramp-down, half refund to buyer. Deliberately unsatisfying: its purpose is to push parties to settle via `resolve_dispute` instead. If you wait for this to fire, you're saying you couldn't agree on anything else.

### Buyer cancels (provider hasn't started yet)

**`cancel_with_notice`** (buyer, milestone `Pending`)

Milestone `Pending → CancelledByBuyer`. Full refund to buyer. **No reputation ding** — the provider hadn't started the milestone, no work was wasted.

### Buyer cancels with penalty (work in flight)

**`cancel_with_penalty`** (buyer, milestone `Started` or `Submitted`)

Milestone → `CancelledByBuyer`. 50% to provider as ramp-down compensation, 50% refund to buyer. Clears active. Buyer's `cancelled_milestones` counter bumps — the buyer is acknowledging they pulled the plug on work in progress.

### Buyer cancels after provider missed delivery

**`cancel_late_milestone`** (buyer, milestone `Started` and past `delivery_deadline`)

Milestone → `CancelledByBuyer`. **Full refund** to buyer, no penalty paid. Provider's `late_milestones` counter bumps — the deadline was the provider's commitment, so the buyer takes no ding here.

---

## Reference

- `programs/tender/src/state/rfp.rs` — `Rfp` account + `RfpStatus` enum + max milestone count
- `programs/tender/src/state/escrow.rs` — `MilestoneState` + `MilestoneStatus`
- `programs/tender/src/instructions/` — one file per action, exactly one transition each
- See [reputation-model](/docs/reputation-model) for what each settlement-path action writes to BuyerReputation / ProviderReputation
- See [privacy-model](/docs/privacy-model) for the binding-signature flow that surfaces a private-mode winner's main wallet at award time
