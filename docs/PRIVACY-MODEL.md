# Tender — Privacy Model

> The cryptographic and architectural rationale behind how Tender keeps procurement bids confidential. This is the canonical source of truth: everything else (UI tooltips, marketing copy, grant submissions, sponsor write-ups) should reduce from this document.

## The one-line guarantee

> **Bid contents are sealed from everyone — including the buyer who posted the RFP — until the bid window closes. Sealing is enforced cryptographically, not by policy.**

Everything else in this document is structure around that single sentence: how it's enforced, what's left configurable, what becomes public on award, and why it matters for real procurement.

---

## Privacy at every lifecycle stage

| Stage | Bid contents | Bidder identity (L0 default) | Bidder identity (L1 toggle) | Settlement amount |
|---|---|---|---|---|
| **Window open** (bids being submitted) | 🔒 Sealed from everyone, including the buyer | 🌐 Public | 🔒 Sealed from everyone | n/a |
| **Window closed** (`bid_close_at` passed) | 🔒 Still sealed until reveal window opens (anyone can call `open_reveal_window` once the deadline passes) | 🌐 Public | 🔒 Sealed from everyone | n/a |
| **Reveal window** (post-window, pre-award) | 🔓 Buyer + each bidder can decrypt their own bid; public still sees nothing | 🌐 Public | 🔓 Buyer-only | n/a |
| **Awarded** (winner selected) | Winning bid: 🌐 Published to base layer. Losing bids: 🔒 Stay sealed forever, only buyer + their bidder can decrypt. | 🌐 Public | Winner: 🌐 published. Losers: 🔓 Buyer-only. | n/a |
| **Funded** (Cloak shielded escrow) | (settled, not relevant) | (settled) | (settled) | 🔒 Shielded via Cloak — observers see "buyer → Cloak pool" and "Cloak pool → someone" but cannot link them |

🔒 = cryptographically inaccessible · 🔓 = decryptable by listed parties only · 🌐 = readable by anyone on devnet/mainnet.

---

## Why hide bids from the buyer (not just paranoia)

This is the design choice that surprises people most. "Why hide bids from the buyer? They posted the RFP." Three reasons it matters in real procurement:

### 1. Collusion is the canonical RFP fraud

The "buyer" in the smart-contract sense — a single keypair, a multisig signer, a treasury delegate, a procurement officer at a DAO — is rarely identical with the *organization* the RFP serves. If they can read bids as they arrive, they can:

- **Tip a favored vendor.** "I see X just bid 100k, you can come in at 95k." This is the classic procurement-fraud pattern. Public-sector RFPs have legal rules against it and a ceremonial bid-opening date precisely to prevent it.
- **Seed sham bids to set floors.** Anonymous low-quality bids from associates manipulate the price discovery curve.
- **Front-run competitors.** Coordinate with a preferred provider to undercut others before close.

Tender enforces this cryptographically instead of relying on legal liability. The TEE-backed validator running the Private Ephemeral Rollup will not return bid ciphertext to the buyer's wallet until the on-chain `open_reveal_window` instruction has been executed — and that instruction reverts if `clock.unix_timestamp < rfp.bid_close_at`. There is no buyer-side "peek" path.

### 2. It's a credible-commitment device — buyers benefit from binding themselves

Provider behavior under uncertainty: if providers know the buyer can peek, they bid defensively (higher price, more conservative scope, less revealing methodology). If they know the buyer *cannot* peek — by infrastructure, not promise — they bid more aggressively (lower price, sharper scope, more proprietary detail). Better bids attract better providers, which attracts better RFPs, which attracts better providers. The buyer wins by voluntarily binding themselves not to peek.

This is the same logic as a sealed-bid first-price auction in classical mechanism design: the seller credibly commits to not running a discriminatory auction, and bidders respond by bidding closer to their true valuation.

### 3. It's a sharper pitch

"Sealed from everyone, including the buyer, until the window closes" is a one-line cryptographic guarantee a sophisticated user can verify. "Encrypted, but we trust the buyer not to peek" is a hand-wavy promise. For Tender as a marketplace seeking trust from both sides, the first lands harder.

---

## Bidder identity: L0 vs L1

Bid *contents* are always sealed (above). Bidder *identity* — i.e., which providers submitted bids on a given RFP — is configurable per RFP at creation time.

### L0: Public bidder list (default)

Anyone can see which providers have bid on which RFP. Only bid contents are sealed.

**When to pick L0 (the default):**
- Most procurement. Buyers want to know they're getting bids from qualified providers (vetting, reputation, prior work).
- Providers want public bidding history as reputation — "Audit DAO X bid on the OpenSea RFP" is a positive signal even when they lose.
- Standard private-sector RFP: the bidder pool is known, only the bid terms are private.
- Required for the Tender reputation registry (Day 9): reputation tracks won contracts + completed milestones, and identity must be linkable.

**Implementation:** the on-chain `BidCommit` PDA is derived from `[b"bid", rfp_pda, provider_wallet]`. Anyone scanning the program's accounts via `getProgramAccounts` can enumerate "Provider X bid on RFP Y."

### L1: Private bidder list (per-RFP toggle)

Only the buyer (after the bid window closes) can see who bid. Public observers see only the bid count.

**When to pick L1:**
- **Sensitive procurement.** M&A advisory, executive search, security audit of an unannounced product, legal counsel for a contested matter — RFPs where disclosing the bidder pool itself leaks competitive or strategic information.
- **Anti-collusion in oligopolistic markets.** When the realistic bidder pool is small (3–5 known firms in a vertical), publishing who bid lets remaining bidders coordinate on price.
- **Whistleblower / journalism / advocacy procurement.** Organizations whose vendor relationships themselves are sensitive.

**Implementation:**
- PDA derivation switches to `[b"bid", rfp_pda, bid_seed]` where `bid_seed = sha256(walletSig("tender-bid-seed-v1" || rfp_nonce))`. Deterministic — provider can re-derive their PDA from their wallet alone, no client-side state needed.
- The `BidCommit` account stores `provider_hash: [u8; 32] = sha256(provider_wallet)` instead of `provider: Pubkey`. The actual `provider_wallet` is ECIES-encrypted to the buyer's pubkey alongside the bid envelopes.
- Authorization for `withdraw_bid` and `select_bid` verifies `sha256(signer) == provider_hash` instead of comparing pubkeys directly.
- Provider lookup on `/providers/[wallet]` requires the provider to be signed in (we filter by `provider_wallet_hash` + verified session).
- Reputation: L1 bids contribute to reputation **only on win** (when buyer publishes the winner, identity is on-chain anyway). Losing L1 bids leave no public footprint and no reputation credit. This is the explicit trade-off of choosing L1: stronger privacy, weaker reputation-building.

### What L1 is *not*

L1 is **not** "blind bidding even from the buyer until select." That stronger model (we'd call it L2) prevents the buyer from biasing selection by knowing who bid, but conflicts with vetting and reputation-aware evaluation. We're not building L2 today; it can layer on later as an additional per-RFP option.

---

## The reveal model (V3)

When the bid window closes and a winner is selected, what becomes public?

**Tender uses the V3 model: winner published on award, losers stay sealed forever.**

| | Winner | Losing bidders |
|---|---|---|
| Bid contents | 🌐 Published to base layer on `select_bid` (account undelegated from PER, ciphertext lands on devnet — buyer's pubkey is published in the RFP, so the bid is decryptable by anyone) | 🔒 Stay sealed on PER permanently. Only the buyer + the bidder themselves can ever decrypt them. |
| Bidder identity | 🌐 Published (always — necessary for payment and reputation) | L0: 🌐 Published. L1: 🔓 Buyer can see; public sees only "this RFP got N bids." |
| Reputation credit | ✅ Increments | ❌ No credit |

**Why V3 (winner public, losers private):**

Matches real-world procurement norms. Public-sector contracts are typically published (price + scope + winner) — taxpayers, shareholders, and DAO members deserve to verify the choice was reasonable. Losing bids stay confidential because publishing them would discourage participation: providers don't want their pricing models, methodologies, and team compositions broadcast to the world every time they lose.

The provider-friendly framing matters: providers will bid more aggressively on Tender knowing that a loss costs them nothing reputationally and reveals no proprietary information. That sharpens bids, which benefits buyers, which attracts more buyers, which attracts more bidders. The flywheel runs on the loser-privacy guarantee.

---

## Architecture in one screen

Two cryptographic layers stacked:

1. **ECIES (X25519 + XChaCha20-Poly1305)** at the application layer. Each bid is encrypted into two envelopes — one to the buyer's RFP-specific pubkey, one to the bidder's per-wallet pubkey. The buyer's pubkey is derived deterministically from their wallet signature over a per-RFP nonce; the provider's pubkey is derived deterministically from their wallet signature over a per-wallet domain string. No keys are ever stored. Refresh = re-sign + re-decrypt.

2. **MagicBlock Private Ephemeral Rollup (PER)** at the storage and access-control layer. Bid envelopes are written into a delegated `BidCommit` account whose reads are gated by a permission account inside an Intel TDX TEE-backed validator. While delegated, only members of the permission account can read the bid via the ER RPC. The on-chain Tender program controls the permission membership: provider is added at `commit_bid` time; buyer is added by the permissionless `open_reveal_window` instruction, which reverts if `clock.unix_timestamp < rfp.bid_close_at`.

**Why both layers:** PER provides time-locked access control (the unique value); ECIES provides a fallback if the bid is ever undelegated. After award, the winning bid is undelegated and lands on base-layer devnet — at which point the only thing protecting it is "the buyer's pubkey is published in the RFP, so anyone can decrypt." That's intentional for the winner. For losers, the bid stays delegated and ECIES is irrelevant; PER's permission gate is the active mechanism.

**Threat model:**
- An attacker who compromises the Tender API or database sees encrypted-or-absent ciphertext — the actual bytes live on PER, not in our DB.
- An attacker who compromises a buyer's wallet can derive their X25519 priv and decrypt all bids on RFPs they've posted. Same as compromising any wallet — bound to wallet security.
- An attacker who compromises a provider's wallet can decrypt only that provider's own bids. Per-wallet derivation keeps blast radius small.
- A malicious validator running the ER cannot read bids — Intel TDX seals memory from the host. (TEE compromise is a separate, broader risk we inherit from the MagicBlock infrastructure.)
- The buyer cannot read bids before `bid_close_at` — enforced by the on-chain instruction's clock check, which the validator honors.

---

## Out of scope (intentionally)

What this document does **not** promise, and why:

- **Privacy of the RFP itself.** RFP titles, scopes, budgets, and milestone structures are public on-chain. Tender is a marketplace — buyers need to be discoverable. If a buyer needs to publish a vague public scope plus a confidential detailed scope, the schema includes `scope_detail_encrypted` (encrypted to an allowlist of providers); not yet wired through the UI. Future work.
- **Privacy of buyer identity.** The buyer's wallet is on every RFP. If you want pseudonymous procurement (e.g., a DAO posting under a fresh address), use a fresh address — Tender doesn't link wallets to off-chain identities by default.
- **Fully blind bidding (L2).** Buyer knows bidders' identities at reveal in both L0 and L1. If you want buyer-blind selection (only winner identity revealed), that's a future toggle.
- **Provider verification beyond pseudonymous (Tier 0).** No KYC, no reputation oracles, no proof-of-prior-work. Reputation is built natively through the registry (won contracts + completed milestones).
- **Encryption-key rotation.** ECIES keys are deterministic per (wallet, rfp_nonce). If a buyer suspects key compromise, they must cancel the RFP. A rotation epoch is a future addition.
- **Settlement-amount privacy on devnet.** Cloak shielded settlement runs on mainnet — devnet payouts are public USDC transfers. This is a sponsor-track choice, not a privacy gap in our design.

---

## Reference

- `programs/tender/src/instructions/commit_bid.rs` — encrypt-to-both + delegate to PER + create permission
- `programs/tender/src/instructions/open_reveal_window.rs` — clock-gated permission update on ER
- `apps/web/lib/sdks/magicblock.ts` — dual-connection (base + ER), permission lifecycle
- `apps/web/lib/crypto/ecies.ts` + `derive-rfp-keypair.ts` + `derive-provider-keypair.ts` — application-layer crypto
- MagicBlock PER docs: <https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart>
