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
| **Funded → in progress** | (settled) | (settled) | (settled) | Public USDC transfers on devnet · shielded via Cloak on mainnet |

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

## Two privacy modes

Bid contents are always sealed (above). Bidder *identity* — i.e., which wallets submitted bids on a given RFP — is configurable per RFP at creation time. The form labels these:

- **"Bid contents private"** (default)
- **"Bid contents + bidder identity private"**

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

1. **Per-RFP ephemeral wallet.** Provider's main wallet signs a single deterministic message (`tender-ephemeral-bid-v1 || rfp_pda`); the resulting Ed25519 signature is HKDF-expanded into a fresh keypair. Deterministic so the provider can re-derive it on any client without storing key material.

2. **Cloak shielded funding.** The ephemeral wallet has 0 SOL by default. To pay for bid txs, the provider tops it up via Cloak's shielded UTXO pool: deposit from main wallet → ZK-shielded transfer → relay-paid withdraw to ephemeral. The on-chain "By" column on every bid tx shows only the ephemeral wallet, with no provable link to the main wallet.

3. **Bid commitment uses the ephemeral wallet.** The commitment account becomes `[b"bid", rfp_pda, ephemeral_wallet]`. The encrypted envelope inside it carries the provider's *main* wallet plus a binding signature (main wallet signs `tender-bid-binding-v1 || program_id || rfp_pda || bid_pda || main_wallet`).

4. **Reveal happens at award.** When the buyer awards a private bid, the award transaction includes an Ed25519 signature-verification instruction that proves the main wallet committed to that bid. The program writes the verified main wallet to `rfp.winner_provider`. From this moment forward the winner's main wallet is on-chain — needed for reputation, for milestone payouts, and for the provider to manage their project.

5. **Reputation auto-binds on win.** Because the on-chain winner field is the verified main wallet, reputation updates accrue to it identically to a public-mode win. There's no separate "claim later" step.

6. **Losers stay sealed.** Losing bidders' main wallets are never revealed. Their bid envelopes are never decrypted in a context that publishes the main wallet on chain.

### Where private-bidder mode hides identity

Hiding identity at the account-data layer (the bid commitment carries the ephemeral wallet, not the main wallet) is necessary but not sufficient. tendr.bid hides identity at every layer that matters:

- **Account data**: bid commitment carries the ephemeral wallet — opaque to anyone who didn't generate it.
- **Transaction history**: every bid tx is signed by the ephemeral wallet, funded via Cloak's shielded pool. Block explorers see only the ephemeral wallet, and Cloak's Groth16 ZK proof breaks the funding link to the main wallet.
- **Reputation**: only the winner's main wallet ever appears on chain, after the buyer has already committed to that bid. Losing bids leave no main-wallet trace.

Cloak's shielded pool provides **cryptographic** unlinkability (Groth16 ZK proof, not operational obfuscation). Spike-verified end-to-end on devnet 2026-05-01: a wallet with literally 0 SOL and no on-chain history (`G7dWnk4sDpecqCZRy8Q5y2t86NfourvT4K6MuvHrbhxq`) received 0.04485 SOL with no traceable funding link.

**Caveat on the privacy set.** The cryptographic property is real, but practical anonymity scales with how many other people are using Cloak's pool concurrently. Devnet pool activity is currently modest (~7 distinct depositors per 30-tx window); mainnet is significantly larger. Honest about the tradeoff.

### What private-bidder mode is NOT

It's not "blind bidding even from the buyer until select." That stronger model (call it L2) prevents the buyer from biasing selection by knowing who bid, but conflicts with vetting and reputation-aware evaluation. It's a future toggle, not what we ship today.

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

## Out of scope (intentionally)

What this design does NOT promise, and why:

- **Privacy of the RFP itself.** RFP titles, scopes, budgets, and milestone structures are public on-chain. tendr.bid is a marketplace — buyers need to be discoverable. Encrypted-scope flow with a per-bidder allowlist is a future design.
- **Privacy of buyer identity.** The buyer's wallet is on every RFP. If you want pseudonymous procurement, use a fresh address — tendr.bid doesn't link wallets to off-chain identities.
- **Fully blind bidding** (buyer can't see bidders even at reveal). Conflicts with vetting and reputation-aware evaluation. A future toggle.
- **Provider verification beyond pseudonymous.** No KYC, no oracles, no proof-of-prior-work. Reputation is built natively through the on-chain registry — see [reputation-model](/docs/reputation-model).
- **Encryption-key rotation.** Keys are deterministic per (wallet, rfp_nonce). If a buyer suspects key compromise, they cancel the RFP. Rotation epoch is a future addition.
- **Settlement-amount privacy on devnet today.** Cloak shielded settlement is a mainnet capability — devnet payouts are public USDC transfers. On the mainnet roadmap, not a privacy gap in the design.

---

## Reference

- `programs/tender/src/instructions/commit_bid_init.rs` — bid init (provider field = main wallet in default mode, ephemeral in private-bidder mode)
- `programs/tender/src/instructions/delegate_bid.rs` — delegate to PER + create permission
- `programs/tender/src/instructions/open_reveal_window.rs` — clock-gated permission update
- `programs/tender/src/instructions/select_bid.rs` — winner record + Ed25519 binding-signature verification
- `apps/web/lib/sdks/magicblock.ts` — dual-connection + permission lifecycle
- `apps/web/lib/sdks/cloak.ts` — Cloak shielded ephemeral wallet funding
- `apps/web/lib/sdks/magicblock-payments.ts` — milestone release routing through Private Payments API
- `apps/web/lib/crypto/` — ECIES + key derivation
- See [lifecycle](/docs/lifecycle) for the full RFP state machine, and [reputation-model](/docs/reputation-model) for what each settlement-path instruction writes to the on-chain reputation accounts.
- MagicBlock PER docs: <https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart>
- Cloak SDK quickstart: <https://docs.cloak.ag/sdk/quickstart>
