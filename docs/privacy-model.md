# How privacy works on tendr.bid

> The short version: bid contents are sealed from everyone — including the buyer who posted the project — until the bid window closes. That isn't a policy, it's a cryptographic guarantee enforced by the system.

This doc walks through what stays sealed, what becomes public, when each transition happens, and what the threat model looks like. If you're after the user-facing summary, read the [FAQ](/docs/faq) first.

---

## At a glance

| Stage | Bid amount + scope | Bidder identity (default mode) | Bidder identity (private-bidders mode) | Settlement |
|---|---|---|---|---|
| **Bidding open** | 🔒 Sealed from everyone — even the buyer | 🌐 Public | 🔒 Sealed (no link to a main wallet) | n/a |
| **Bid window closed**, reveal not yet open | 🔒 Still sealed | 🌐 Public | 🔒 Sealed | n/a |
| **Reveal window** (post-close, pre-award) | 🔓 Buyer + each bidder can decrypt their own bid | 🌐 Public | 🔓 Buyer can decrypt the envelope and see who bid | n/a |
| **Awarded** | Winning bid: 🌐 published. Losing bids: 🔒 sealed forever | 🌐 Public | Winner: 🌐 main wallet revealed via binding signature. Losers: 🔒 main wallets stay hidden | n/a |
| **Funded → in progress** | (settled) | (settled) | (settled) | Public USDC transfers on devnet |

🔒 = cryptographically inaccessible · 🔓 = decryptable by listed parties only · 🌐 = readable by anyone

---

## Why hide bids from the buyer

The most common reaction: "But the buyer posted the project — why hide bids from them?" Three reasons it matters in real procurement.

### Anti-collusion

Procurement fraud's classic move: the buyer (a single keypair, a multisig signer, a treasury delegate, an officer at a DAO) sees an early bid arrive at $100k and quietly tells a favored vendor "come in at $95k." Or seeds sham bids from associates to manipulate price discovery. Public-sector RFPs have legal rules and ceremonial bid-opening dates precisely to prevent this.

tendr.bid enforces it by infrastructure instead of by legal liability. The TEE-backed validator running the Private Ephemeral Rollup will not return bid contents to the buyer's wallet until the on-chain `open_reveal_window` instruction has been executed — and that instruction reverts if the bid window hasn't closed yet. There is no buyer-side "peek" path. Even if the buyer wanted to cheat, the system won't let them.

### Better bids when buyers can't peek

Provider behavior under uncertainty: if providers know the buyer can peek, they bid defensively (higher price, more conservative scope, less revealing methodology). If they know the buyer cannot peek — by infrastructure, not promise — they bid more aggressively (lower price, sharper scope, more proprietary detail). Buyers benefit by binding themselves not to peek.

### A guarantee, not a promise

"Sealed from everyone, including the buyer, until the window closes" is a one-line claim a sophisticated user can verify. "Encrypted, but we trust the buyer not to peek" is a hand-wavy promise. tendr.bid prefers the version that's checkable.

---

## Two orthogonal privacy axes

Bid contents are always sealed (above). On top of that, **bidder identity** and **buyer identity** are independently configurable per RFP at creation time.

**Bidder privacy** (form label: "Bidder privacy mode"):
- **"Bid contents private"** (default) — bidder wallet visible
- **"Bid contents + bidder identity private"** — bidder wallet hidden

**Buyer privacy** (form label: "Buyer privacy mode"):
- **"Public buyer"** (default) — RFP's `buyer` field on chain is the main wallet
- **"Anonymous buyer"** — RFP signed by an HD-derived buyer ephemeral funded via Cloak

Four combinations: public/public, public-buyer + private-bidder, private-buyer + public-bidder, fully sealed.

The mechanism on each side is symmetric — both modes use HD-derived ephemerals from the same keychain, both fund through Cloak's shielded pool, both accrue reputation to a per-ephemeral PDA, both merge into the main wallet via an explicit claim ix on the user's terms (`attest_buyer_history` for buyers, `attest_win` for providers — see "Claim-based reputation merge" below).

### Default mode: contents private, bidder visible

Bid amounts and scopes are sealed in the TEE; bidder wallets are visible on-chain.

When this is the right pick:

- Most procurement. Buyers want to see they're getting bids from qualified providers (vetting, reputation, prior work).
- Providers want public bidding history as positive reputation — "this provider bid on the OpenSea audit RFP" reads as a signal even when they don't win.
- The bidder pool is reasonably known and the only thing actually private is what each one is offering.

How it's implemented: the bid commitment account is derived from `[b"bid", rfp_pda, provider_main_wallet]`. Anyone scanning the program's accounts can enumerate "Provider X bid on RFP Y." The provider field on the commitment IS the main wallet, so reputation accrues to it directly on award.

### Private-bidder mode: contents AND identity sealed

Bid amounts, scopes, AND the provider's main wallet all stay sealed. The buyer learns who bid only at reveal (by decrypting the envelope). The public learns only the bid count.

When this is the right pick:

- **Sensitive procurement**: M&A advisory, executive search, security audit of an unannounced product, legal counsel for a contested matter — RFPs where the bidder list itself leaks competitive or strategic information.
- **Anti-collusion in small markets**: When the realistic bidder pool is 3–5 known firms in a vertical, publishing who bid lets the rest coordinate on price.
- **Whistleblower / journalism / advocacy procurement**: Organizations whose vendor relationships themselves are sensitive.

How it works under the hood (you don't have to understand this to use it, but here's the mechanism):

1. **HD-derived bidder ephemeral.** Provider's main wallet signs a single deterministic master message (`tender-keychain-master-v1`); the resulting Ed25519 signature is HKDF-expanded into a 32-byte master seed cached in tab-scoped sessionStorage. From that seed, every per-role ephemeral the user will ever need is derived deterministically — bidder ephemerals (one per bid), buyer ephemerals (one per private RFP), funding/refund/payout sub-wallets — so a user gets exactly **one** wallet popup per session even as they bid on multiple RFPs and run multiple flows. Cross-tab sync via BroadcastChannel; same keychain handle backs every surface.

2. **Cloak shielded funding.** The bidder ephemeral has 0 SOL by default. The provider tops it up via Cloak's shielded UTXO pool: deposit from main wallet → ZK-shielded transfer (Groth16 proof) → relay-paid withdraw to ephemeral. The on-chain "By" column on every bid tx shows only the ephemeral wallet; the funding link to the main wallet is broken cryptographically.

3. **Bid commitment uses the ephemeral wallet.** The commitment account becomes `[b"bid", rfp_pda, ephemeral_wallet]`. `bid.provider` is the ephemeral pubkey. The encrypted envelope inside carries a binding signature from the main wallet (signs `tender-bid-binding-v1 || program_id || rfp_pda || bid_pda || main_wallet`) — used later for the optional claim, not for the live bid.

4. **The bidder ephemeral signs every post-award action.** When the bid wins, all subsequent provider actions (`start_milestone`, `submit_milestone`, `propose_dispute_split`, `auto_release_milestone`, etc.) sign with the **bidder ephemeral**, not the main wallet. This is the load-bearing piece: without it, the very first milestone tx would leak the eph→main link via the tx fee payer. Every action through project completion stays on the ephemeral.

5. **ProviderReputation accrues to the ephemeral.** During the project, the eph's per-role ProviderReputation PDA tracks wins, completions, dispute counts, earnings — all the same fields as a normal main-wallet rep account. The user's main wallet stays unlinked.

6. **Optional claim merges into main wallet rep.** After the RFP completes, the user runs **Claim reputation** from their dashboard. The `attest_win` ix verifies the cached binding signature on chain (Ed25519SigVerify precompile), atomically copies the eph's counters into the main wallet's ProviderReputation, and flips a `winner_attested` idempotency flag. Until the user calls this, no on-chain link exists between the main wallet and the anonymous win.

7. **Losers stay sealed forever.** Losing bidders' main wallets are never revealed — even if their winning peer claims, the program ix only ever links the winning bid's main wallet, never the losers'.

### Where private-bidder mode hides identity

Hiding identity at the account-data layer (the bid commitment carries the ephemeral wallet, not the main wallet) is necessary but not sufficient. tendr.bid hides identity at every layer that matters:

- **Account data**: bid commitment carries the ephemeral wallet — opaque to anyone who didn't generate it.
- **Transaction history**: every bid tx is signed by the ephemeral wallet, funded via Cloak's shielded pool. Block explorers see only the ephemeral wallet, and Cloak's Groth16 ZK proof breaks the funding link to the main wallet.
- **Reputation**: only the winner's main wallet ever appears on chain, after the buyer has already committed to that bid. Losing bids leave no main-wallet trace.

Cloak's shielded pool provides **cryptographic** unlinkability (Groth16 ZK proof, not operational obfuscation). Spike-verified end-to-end on devnet 2026-05-01: a wallet with literally 0 SOL and no on-chain history (`G7dWnk4sDpecqCZRy8Q5y2t86NfourvT4K6MuvHrbhxq`) received 0.04485 SOL with no traceable funding link.

**Caveat on the privacy set.** The cryptographic property is real, but practical anonymity scales with how many other people are using Cloak's pool concurrently. Devnet pool activity is currently modest (~7 distinct depositors per 30-tx window); mainnet is significantly larger. Honest about the tradeoff.

### What private-bidder mode is NOT

It's not "blind bidding even from the buyer until select." That stronger model — buyer can't see *who* bid even at reveal time — conflicts with vetting and reputation-aware evaluation, which are core to the buyer's decision. tendr.bid deliberately stops one step short of fully blind: contents stay sealed from the buyer until close, identity stays sealed from observers throughout, but the buyer learns who bid at reveal so they can evaluate counterparty fit alongside the bid itself.

---

### Anonymous-buyer mode: RFP + buyer identity sealed

The mirror of private-bidder mode, applied to the buyer side. The RFP itself is signed by an HD-derived buyer ephemeral funded via Cloak's shielded pool; the buyer's main wallet leaves zero on-chain footprint during the RFP's lifecycle.

When this is the right pick:

- **Strategic procurement** where the buying organization's identity is the sensitive piece (the budget alone might tip off a competitor that you're entering a market, or signal an upcoming pivot to your own community).
- **Private treasury operations** for DAOs / multisigs that don't want every RFP they post tied to their public treasury wallet.
- **Personal-budget projects** where the buyer doesn't want to publish a wallet they also use for other on-chain activity.

How it works:

1. **HD-derived buyer ephemeral.** Same keychain primitive as the bidder side — one master signature on first use, all future buyer ephemerals derive from that seed. Cross-tab cache survives reload.
2. **Cloak shielded funding.** The buyer ephemeral is funded with ~0.05 SOL from Cloak's shielded pool at create time. That covers every privacy-preserving signature the buyer will make on this RFP through completion (close bidding, reveal, award, fund, accept milestone, release). Refundable any time via the Ephemeral Sweep panel on the dashboard.
3. **The buyer ephemeral signs every action.** `rfp_create`, `rfp_close_bidding`, `open_reveal_window`, `select_bid`, `fund_project`, `accept_milestone`, `cancel_*`, `propose_dispute_split` — all signed by the ephemeral. Main wallet never appears as a tx fee payer.
4. **BuyerReputation accrues to the ephemeral.** Same shape as ProviderReputation on the bidder side — per-eph PDA tracks RFPs awarded, funded, completed, ghosted, USDC locked/released/refunded, milestone counters.
5. **Optional claim merges into main wallet rep.** After the RFP completes, the user runs **Claim reputation** from the Buying tab on the dashboard. The `attest_buyer_history` ix atomically copies the eph's BuyerReputation counters into the main wallet's, idempotent via a `buyer_attested` flag on the RFP.

### Where private-buyer mode hides identity

Same threat-model surfaces as private-bidder mode, on the buyer side:

- **Account data**: `rfp.buyer` carries the ephemeral pubkey. Anyone scanning the program can see "ephemeral X created RFP Y" but cannot link it to a main wallet.
- **Transaction history**: every buyer-side action through the RFP's lifecycle is signed by the ephemeral, funded via Cloak.
- **Reputation**: counters accrue to the eph's BuyerReputation PDA. The main wallet's rep stays unchanged unless the user explicitly claims via `attest_buyer_history`.

---

## Claim-based reputation merge (symmetric anonymity)

Both private-buyer and private-bidder modes share the same end-of-project pattern: reputation accrues to the **ephemeral's** PDA during the project, and an **optional, idempotent claim ix** merges those counters into the main wallet's rep when the user is ready.

| Side | Claim ix | Eph rep PDA | Idempotency flag | Surface |
|---|---|---|---|---|
| Buyer | `attest_buyer_history` | `[b"buyer_rep", buyer_eph]` | `rfp.buyer_attested: bool` | Dashboard → Buying tab → "Claim reputation" CTA on completed-anonymous cards |
| Provider | `attest_win` | `[b"provider_rep", bidder_eph]` | `bid.winner_attested: bool` | Dashboard → Bidding tab → "Claim reputation" CTA on completed-anonymous cards |

Both ix:

- **Gate to `RfpStatus::Completed`** — claims are only allowed once the project is in a terminal "delivered" state. No partial claims, no claims while a project is still in flight.
- **Atomically copy every counter** from the ephemeral PDA into the main-wallet PDA. RFPs/wins, completed projects, late milestones, dispute counters, USDC totals — all in one tx.
- **Verify a binding signature** via the Ed25519SigVerify precompile, proving the main wallet that's running the claim is the same main wallet that originally derived the ephemeral. Without this check, anyone could front-run a claim and steal another user's anonymous reputation.
- **Set the idempotency flag** so a second call reverts. One claim per RFP/bid, ever.

What the claim does NOT do:

- It does NOT rewrite `rfp.buyer` or `bid.provider` on chain — those stay as the ephemeral pubkey forever. Surfacing the claimed RFP under the main wallet's profile-page RFP list would re-create the eph→main link the project ran under, defeating the privacy property. Only the reputation **counters** merge.
- It does NOT touch losing bidders' state. A buyer claiming their RFP doesn't reveal who lost; a provider claiming their win doesn't reveal who else bid.
- It does NOT consume the ephemeral PDA. The eph's rep account stays in place but is dead — its counters were already copied. The leaderboard filters known ephemerals out so they don't pollute the rankings (see `apps/web/app/leaderboard/page.tsx` `ephemeralBuyers` set construction).

---

## What becomes public on award

| | Winner | Losing bidders |
|---|---|---|
| Bid contents | 🌐 Published. The bid envelope lands on Solana base layer; the buyer's pubkey is in the RFP, so anyone can decrypt. | 🔒 Stay sealed on the TEE permanently. Only the buyer + the bidder themselves can ever decrypt them. |
| Bidder identity | 🌐 Published. Default mode: was always public. Private-bidder mode: revealed via the Ed25519 binding signature in the award tx. | Default mode: 🌐 always public. Private-bidder mode: 🔒 main wallet stays hidden; only the ephemeral signer is visible. |
| Reputation credit | ✅ Increments on the verified main wallet | ❌ No credit |

**Why publish only the winner.** Matches real-world procurement. Public-sector contracts publish the winner + price + scope so taxpayers, shareholders, and DAO members can verify the choice was reasonable. Losing bids stay confidential because publishing them would discourage participation: providers don't want their pricing models, methodologies, and team compositions broadcast every time they lose.

The flywheel runs on the loser-privacy guarantee: providers bid more aggressively when a loss costs them nothing reputationally and reveals no proprietary information. Better bids → better outcomes → more buyers → more providers.

---

## Architecture in one screen

Three cryptographic layers stacked:

1. **ECIES (X25519 + XChaCha20-Poly1305)** at the application layer. Each bid is encrypted into two envelopes — one to the buyer's per-RFP key, one to the bidder's per-wallet (or per-ephemeral-wallet) key. Keys are derived deterministically from wallet signatures over domain-separated messages. No keys are ever stored — re-decryption = re-sign.

2. **MagicBlock Private Ephemeral Rollup (PER)** at the storage and access-control layer. Bid envelopes are written into a delegated commitment account whose reads are gated by a permission account inside an Intel TDX TEE-backed validator. While delegated, only members of the permission account can read the bid via the rollup RPC. The on-chain Tendr program controls permission membership: provider is added at commit time; buyer is added by the permissionless `open_reveal_window` instruction, which reverts if the bid window hasn't closed yet.

3. **Ed25519SigVerify binding** at the on-chain reveal layer. For private-mode bids, the award instruction reads an Ed25519 signature-verification instruction at index 0, validates that the provider's main wallet signed `tender-bid-binding-v1 || program_id || rfp_pda || bid_pda || main_wallet`, and writes the verified main wallet to the RFP. This is the moment a private winner becomes on-chain-linkable — and only the winner.

**Why all three.** PER provides the time-locked access control (the unique value); ECIES provides a fallback if the bid is ever undelegated (winner case) and lets the bidder always read their own envelope; the binding signature lets a private-mode winner accrue reputation against their main wallet without breaking the main-wallet-unlinkability of losing bidders.

---

## Threat model

What tendr.bid protects against, and what it doesn't:

- **Compromised tendr.bid backend** → attacker sees encrypted-or-absent ciphertext. Bid bytes live on PER, not in our DB.
- **Compromised buyer wallet** → attacker can derive the buyer's decryption key and read all bids on RFPs they've posted. Same as compromising any wallet — bound to wallet security.
- **Compromised provider's main wallet** → attacker can decrypt only that provider's own bids (across both modes). Per-wallet derivation keeps blast radius small.
- **Malicious validator** → cannot read bids. Intel TDX seals memory from the host. (TEE compromise itself is a separate, broader risk inherited from MagicBlock.)
- **Buyer trying to peek before bid close** → blocked. The on-chain `open_reveal_window` instruction's clock check enforces it; the validator honors it.

---

## Out of scope (by design)

What this design does NOT promise, and why each is a deliberate scope decision:

- **Privacy of RFP scope text.** RFP titles, scopes, budgets, and milestone structures are public on-chain. tendr.bid is a marketplace — buyers need to be discoverable, and providers need to evaluate the work itself before bidding. (Buyer **identity** is a separate axis and is hidable via anonymous-buyer mode — see "Anonymous-buyer mode" above.)
- **Fully blind bidding** (buyer can't see who bid even at reveal). The buyer needs counterparty visibility to evaluate fit, not just price. tendr.bid stops one step short of fully blind: contents stay sealed from the buyer until close, identities stay sealed from outside observers throughout, but the buyer learns the bidder list at reveal so they can vet alongside the bid.
- **Provider verification beyond pseudonymous.** No KYC, no oracles, no proof-of-prior-work — the on-chain reputation registry is the trust signal. See [reputation-model](/docs/reputation-model) for the full set of fields each rep account tracks.
- **Encryption-key rotation.** Keys are deterministic per (wallet, rfp_nonce). If a buyer suspects key compromise, they cancel the RFP and post a new one — rotation is the same primitive as starting over.

---

## What SNS adds (and what it does NOT change)

tendr.bid integrates [Solana Name Service](/docs/identity) to render `.sol` names everywhere wallet hashes appear. **SNS does not weaken any of the privacy guarantees above.** Specifically:

- **SNS resolution is read-only browser-side.** The Tendr Anchor program touches no SNS accounts. SNS is a display-layer enhancement, not a chain-state change.
- **SNS only resolves ALREADY-PUBLIC wallets.** In private-bidder mode, the bid signer is a per-RFP ephemeral wallet — we never SNS-resolve ephemerals. Code convention enforces it (see `apps/web/lib/sns/resolve.ts` precondition + `apps/web/components/escrow/confirm-dialogs.tsx` explicit "no withSns" comment on the ephemeral signer's display).
- **Losing bidders' main wallets stay sealed.** Their main wallets are never linked to their bids on chain. SNS resolution can't surface what was never linked. Always.
- **Winners' main wallets are revealed via the existing Ed25519 binding signature** at `select_bid` time — same mechanism as before SNS existed. We then render the winner's `.sol` name (if set) on their profile, leaderboard, etc. SNS adds no new disclosure here; it labels public data.

Net effect: SNS makes already-public wallets human-readable. It expands zero new public surface. Full detail in [identity](/docs/identity).

---

## Reference

- `programs/tender/src/instructions/commit_bid_init.rs` — bid init (provider field = main wallet in default mode, ephemeral in private-bidder mode)
- `programs/tender/src/instructions/delegate_bid.rs` — delegate to PER + create permission
- `programs/tender/src/instructions/open_reveal_window.rs` — clock-gated permission update
- `programs/tender/src/instructions/select_bid.rs` — winner record + Ed25519 binding-signature verification
- `apps/web/lib/sdks/magicblock.ts` — dual-connection + permission lifecycle
- `apps/web/lib/sdks/cloak.ts` — Cloak shielded ephemeral wallet funding
- `apps/web/lib/crypto/` — ECIES + key derivation
- See [lifecycle](/docs/lifecycle) for the full RFP state machine, and [reputation-model](/docs/reputation-model) for what each settlement-path instruction writes to the on-chain reputation accounts.
- MagicBlock PER docs: <https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart>
- Cloak SDK quickstart: <https://docs.cloak.ag/sdk/quickstart>
