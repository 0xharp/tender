# Frequently asked questions

The fast version: tendr.bid is a sealed-bid procurement marketplace on Solana. Buyers post a project (RFP), providers submit private bids, the buyer picks a winner, USDC sits in escrow and releases as each milestone ships. Disputes have a built-in cool-off + split flow. Reputation is on-chain and portable.

If you're after the why-and-how detail, jump to the [privacy model](/docs/privacy-model), the [lifecycle](/docs/lifecycle), or the [reputation model](/docs/reputation-model).

---

## The basics

### What is tendr.bid?

A marketplace for any work that's good enough to write a brief for: audits, design sprints, marketing campaigns, M&A advisory, legal counsel, market making, engineering scopes, you name it. You post the brief (the RFP), providers submit sealed bids, you pick one, and USDC settles by milestone in escrow. Vertical-agnostic by design.

### How do I get started?

Connect a Solana wallet (Phantom, Backpack, Solflare — anything wallet-standard), sign a one-time message to authorize a session, and you're in. No KYC, no account creation form. From there:

- **Buyers** post an RFP from `New RFP` in the top nav.
- **Providers** browse `/rfps`, open one that fits, and submit a sealed bid.

### Do I need devnet SOL?

Yes — tendr.bid runs on Solana devnet right now. Get devnet SOL from the official [Solana faucet](https://faucet.solana.com/) or any community faucet. You'll need a small amount for transaction fees (well under 0.05 SOL for a full RFP cycle).

### What does it cost?

A 2.5% platform fee on each released milestone. That's the only marketplace fee. Solana network fees are pennies. You also lock the full project value in USDC escrow when you fund the project — that's not a fee, it's the buyer's money sitting in escrow until each milestone settles.

### Why Solana?

Two reasons:

1. **Sub-second finality + cheap fees.** A procurement workflow needs to feel responsive — bidding, awarding, milestone reviews. Solana lets us do that without users tracking pending tx state.
2. **MagicBlock Private Ephemeral Rollups + Cloak.** Solana's the only chain with a TEE-backed rollup primitive that lets us seal bid contents from the buyer until the bid window closes, and a shielded UTXO pool that lets providers stay anonymous while bidding. Without those, sealed-bid procurement is a marketing claim, not a guarantee.

---

## Privacy

### Is my bid actually private?

Yes — and not just "encrypted, please trust us." Bid contents are sealed inside MagicBlock's Private Ephemeral Rollup (a TEE-backed validator), and the on-chain instruction that lets the buyer decrypt them refuses to run before the bid window closes. There is no buyer-side "peek" path. Even if the buyer wanted to, the system won't let them.

Full detail: [privacy-model](/docs/privacy-model).

### Can the buyer see who bid?

Depends on the privacy mode the buyer chose when they created the RFP:

- **Bid contents private** (default): Bid amounts and scopes stay sealed until the buyer awards, but provider wallets are visible. Anyone scanning the program can see "Provider X bid on RFP Y." Most procurement.
- **Bid contents + bidder identity private**: Provider wallets ALSO stay hidden. Bids are signed by a per-RFP ephemeral wallet that's funded through Cloak's shielded pool, so no on-chain link to the provider's main wallet. Right for sensitive procurement (M&A advisory, security audits of unannounced products, journalism, etc.).

### What happens to losing bids?

They stay sealed forever. Only the buyer + the bidder themselves can ever decrypt them. Tendr never publishes losing bids, and providers don't get reputation dings for losing.

This is on purpose: providers should bid aggressively without worrying their pricing models, methodologies, or team compositions get broadcast every time they lose.

### What happens to the winning bid?

It becomes public on award. The buyer's pubkey is in the RFP, so anyone can decrypt the winning bid once the buyer picks a winner. This matches real-world procurement norms — public-sector contracts publish the winner + price + scope so stakeholders can verify the choice was reasonable.

### Can tendr.bid (the team) read my bid?

No. Bid bytes live on MagicBlock's PER, not in our database. We never see plaintext. If our entire backend were compromised, an attacker would see encrypted-or-absent ciphertext.

### What if the validator is malicious?

Intel TDX (the TEE running MagicBlock's validator) seals memory from the host. A malicious operator running the hardware can't read the bids. TEE compromise is a real but separate risk inherited from the underlying infra.

### What if my wallet is compromised?

Same as compromising any wallet — the attacker can sign as you and read everything you can read. Per-wallet key derivation (each wallet derives its own decryption key) keeps blast radius small: a compromised provider wallet only reveals that provider's own bids.

### Are payments private?

On devnet today, escrow + milestone releases are public USDC transfers. On mainnet, milestone payouts can route through MagicBlock's Private Payments API (Cloak) so observers see "buyer → shielded pool" and "shielded pool → someone" but can't link the two. That's settlement-amount privacy on top of bid privacy, and it's on the mainnet roadmap.

---

## Bidding (provider side)

### How do I bid?

1. Browse RFPs at `/rfps`. Filter by status, category, or budget.
2. Open the one you want, click `Submit a sealed bid`.
3. Enter price, scope, milestone breakdown, optional success criteria per milestone.
4. The form encrypts your bid client-side to two envelopes (one for you, one for the buyer) and submits the on-chain commit. Wallet popup once for the encryption key derivation, once for the tx.
5. You can withdraw your bid at any time before the bid window closes.

### Can I edit my bid after submitting?

Not directly — bid commitments are immutable once finalized. You can `withdraw_bid` and submit a new one if the window is still open.

### Can I see my own bid back?

Yes. The bid composer encrypts to two envelopes — yours and the buyer's. You can decrypt your own envelope any time with one wallet signature.

### Do I get reputation for losing?

No reputation credit (positive or negative) for losing. The on-chain record only counts wins, completed projects, disputes, and missed deadlines. Bid often, lose without consequence.

In private-bidder-identity mode, losing bids don't even leave a trace linkable to your main wallet.

### Why is there an "ephemeral wallet" thing for private bids?

When the RFP is set to private bidder identity, the bid has to be signed by a wallet that ISN'T your main wallet (otherwise blockchain explorers would show you in the transaction history). Tendr derives a fresh per-RFP wallet from a signature your main wallet produces — deterministic, so you can re-derive it anywhere with no stored material — and funds it through Cloak's shielded pool. The transaction history then shows only the ephemeral wallet, with no provable link back to you.

When you win, an Ed25519 binding signature in the award transaction proves your main wallet committed to that bid, and your reputation accrues normally.

### What's "Cloak"?

A shielded UTXO pool on Solana. Provider deposits SOL from their main wallet, the pool issues them a shielded note, and they withdraw to the ephemeral wallet via a relay. The Groth16 ZK proof breaks the link between deposit and withdrawal — the only on-chain trace is "main wallet sent to pool" and "pool sent to ephemeral," with no provable connection between the two. We use it to fund the per-RFP ephemeral wallet for private-mode bids.

---

## Awarding + funding (buyer side)

### How do I close bidding?

After `bid_close_at` passes, anyone can call `close_bidding` (you, a bot, any wallet). The RFP flips from `Open` to `Reveal`. From the UI, the action surfaces on your `/me/projects` page when bidding has ended.

### How do I see the bids?

Once bidding is closed, you can decrypt every bid client-side. One wallet signature derives your per-RFP decryption key, and the UI shows price, scope, milestone breakdown, optional success criteria per bid. You evaluate, pick a winner, hit award.

### What if I posted a sealed reserve price?

If you committed a reserve price at RFP creation (sha256 commitment + nonce), you can reveal it at award time. The on-chain `select_bid` instruction enforces it: if the winning bid is below your reserve, the transaction reverts. This lets you set a floor without revealing it during bidding.

### What happens after I award?

The winning bid becomes public. The RFP flips to `Awarded`, and you have a funding window (default 3 days) to lock the full contract value in USDC into escrow. If you miss the deadline, anyone can call `mark_buyer_ghosted` and your reputation takes a hit.

### What if I don't fund?

After the funding deadline, the RFP enters `Ghosted` state. Your `BuyerReputation.ghosted_rfps` counter increments on chain — visible to every future provider who looks at your profile. Bidders also see your `funded_rfps / total_rfps` ratio (your follow-through rate) on every RFP detail page.

### What if I never pick a winner?

If you let the reveal window close without calling `select_bid`, the RFP gets stuck — the on-chain instruction would revert if anyone tried to award after the deadline. Anyone (including you, including a stuck bidder) can call `expire_rfp` permissionlessly to flip the RFP into a terminal `Expired` state. No funds or rent move; the RFP just becomes a clean closed record so the dead "Award the winner" action stops surfacing. If this is your RFP, the action is shown directly on the RFP detail page in an amber-tinted card.

### What if I cancel every milestone before the provider starts?

The on-chain RFP terminates as `Cancelled` (different from `Completed`). Reputation counters don't tick on either side because no work was delivered. The buyer profile UI shows the project as cancelled, not completed — important for the trust signal: a buyer who serially cancels shouldn't appear on chain as having "completed projects." Mixed cases (some delivered, some cancelled) still terminate as `Completed` but the UI labels them "(partial delivery)."

---

## Milestones + payment

### How do milestones work?

When the buyer funds the project, the contract value gets split into N milestones (provider proposed the breakdown in their bid). Only ONE milestone can be in flight at a time. Lifecycle per milestone:

1. Provider clicks `Start` when they actually begin work.
2. Provider clicks `Submit` when work is delivery-ready, optionally attaching a delivery note (link to repo, summary, etc.).
3. Buyer reviews. Three options: `Accept`, `Request changes` (with an optional note), or `Reject` (escalates to dispute).
4. If buyer goes silent past the review window, anyone can call `auto-release` — silence equals consent.

### What's the platform fee?

2.5% per milestone release. Provider receives `amount × 0.975`, treasury gets the rest. Locked per-RFP at creation time so it can't change mid-project.

### What if the provider doesn't deliver on time?

Each milestone has a delivery deadline (provider committed it in their bid). After the deadline, the buyer can call `cancel_late` for a full refund — provider's `late_milestones` counter increments, buyer pays no penalty.

### What if the buyer cancels?

Three buyer-side cancel paths:

- **Cancel-with-notice** (milestone is `Pending`, provider hasn't started): full refund, no rep ding for either side.
- **Cancel-with-penalty** (milestone is `Started` or `Submitted`): 50% to provider as ramp-down compensation, 50% refund to buyer. Buyer's `cancelled_milestones` counter bumps.
- **Cancel-late** (milestone is `Started` and provider missed delivery deadline): full refund, provider gets a `late_milestones` ding.

### What if there's a dispute?

The buyer rejects the milestone, which flips it to `Disputed`. There's a cool-off window (default 3 days) where both parties are expected to settle off-platform — talk it out, agree on a split. Then BOTH sides post the same proposed split on-chain, and funds release per the agreement.

If the cool-off expires without agreement, anyone can call the default 50/50 split. This is deliberately unsatisfying — its purpose is to push parties to agree on something better.

### Can I just talk to the other party?

Yes — every milestone has an off-chain notes thread. When the provider submits, they can attach a delivery note (link, summary). When the buyer requests changes, they can attach what needs fixing. The chain has the immutable record; the notes have the human context.

---

## Reputation

### What's tracked on my reputation?

Two on-chain account types — `BuyerReputation` and `ProviderReputation`, one per wallet, lazy-init on first award. Counters + USDC totals (gross awarded, net earned, refunded, disputed). Full schema in [reputation-model](/docs/reputation-model).

### Is my reputation portable?

It's on the Tender program on Solana — anyone can read it via `getProgramAccounts` without our app being online. Other Solana programs can reference it freely. Reputation is also paired with your `<handle>.tendr.sol` SNS identity (see the [Identity](#identity) section), which means the *recognizable name* attached to your reputation travels with you across every Solana app that resolves SNS. Cross-program reputation portability (mirroring to a generic on-chain registry) is a future v2 feature.

### Does losing a bid hurt my reputation?

No. Reputation only tracks wins, completed projects, disputes, and missed deadlines. Losing has zero impact.

### What if I have a private-mode win?

Reputation accrues to your main wallet identically to public-mode wins. The Ed25519 binding signature at award time proves your main wallet to the program, and every reputation update keys off the verified main wallet.

### Why don't I have a reputation account yet?

It gets lazy-initialized the first time it's needed (your first award as buyer, your first win as provider). New wallets won't have one until they actually do something.

---

## Identity

### What's `<handle>.tendr.sol`?

Your **tendr identity** — a Solana Name Service (SNS) subdomain we mint for you under our parent `tendr.sol` the first time you sign in. It surfaces everywhere a wallet is rendered in the app: leaderboard, buyer/provider profile pages, RFP cards, milestone notes, wallet popover, and shared profile URLs. It's also the hero label on the share-card that unfurls when you paste your profile URL into X / Slack / Discord.

### Do I have to claim one?

No, but you should — without a tendr identity, every UI surface that lists you shows your truncated wallet hash. Claiming takes one click in the onboarding modal that pops up after sign-in: pick a handle (3-20 chars, alphanumeric + hyphens), confirm. **No wallet popup, no signature.** Tendr signs the mint server-side and assigns the subdomain to your wallet in the same transaction.

### Why no signature?

Tendr's parent-domain owner keypair signs the mint atomically and assigns the new subdomain to your wallet. You receive it without authorizing anything on chain — same UX shape as receiving an airdrop.

### Is the subdomain actually mine?

Yes — the on-chain SPL Name Service account that backs `<handle>.tendr.sol` has its `owner` field set to your wallet. Tendr (the parent owner) cannot move it without your signature.

### What handles are reserved?

Hand-curated blocklist of ~70 entries: admin/system roles (admin, root, system, mod, support…), common web reserved (www, api, login, dashboard…), tendr brand (tendr, tendrbid, official…), high-confusion crypto terms (wallet, escrow, treasury, usdc…), and obvious test/placeholder strings (test, demo, null…). Full list in `apps/web/lib/sns/devnet/handle-validation.ts`.

### What does my tendr identity NOT do?

- It does NOT change anything on the privacy side. We never resolve `.tendr.sol` for per-RFP ephemeral bid signers; that's defended in code (`withSns` is opt-in default-false on every render call, plus an explicit "INTENTIONALLY NO withSns" comment on the ephemeral-signer HashLink). Full detail in [identity](/docs/identity).
- It does NOT gate any product behavior. Wallets without a claimed identity can still bid, post RFPs, win projects, accumulate reputation. The name is purely a display + portability layer.
- It does NOT give Tendr any new control over your wallet. We only ever sign mint transactions; the resulting subdomain is yours.

### Is this on mainnet?

No — tendr.bid runs on devnet today, including the identity layer. Same as the rest of the product.

---

## Trust + safety

### How do I know the buyer is real?

You don't, in the KYC sense — tendr.bid is pseudonymous. What you DO have is the buyer's on-chain track record: how many RFPs they've created, how many they've funded, how many they've ghosted, how many milestones they cancelled vs accepted. Look at `/buyers/[wallet]` for any RFP's buyer before bidding. A buyer with zero history isn't necessarily bad, but you should price the risk accordingly.

### How do I know the provider is real?

Same answer in reverse. Look at `/providers/[wallet]` for the provider's wins, completed projects, disputes, late milestones, and total earned. The leaderboard at `/leaderboard` ranks providers by completed projects + earnings.

### What if someone scams?

The dispute flow is the first line. If a provider doesn't deliver or a buyer rejects work in bad faith, the dispute path forces a structured resolution (off-chain settlement → matching on-chain split, or the deliberately-unattractive 50/50 default).

If a party walks away entirely, the on-chain reputation record captures it permanently (cancellations, late milestones, dispute counts, ghosted awards). Future counterparties will see it.

### Is there an escalation path beyond the on-chain dispute?

Not today. Dispute resolution is two-party — the cool-off + matching-split mechanism is designed to push settlement, not require an arbiter. A future arbiter / DAO-court layer could plug in.

---

## Wallets + sessions

### Why do I have to "sign in" after connecting?

Connecting a wallet only proves you have it; it doesn't prove you authorized this app to act on your behalf. The "Sign in" step is Sign-In With Solana (SIWS): you sign a one-time, human-readable message. We mint a session JWT scoped to your wallet for 24 hours. No funds move during sign-in.

### Why does the session expire after 24 hours?

Limits the blast radius if something goes wrong. Re-signing is one click.

### What if I switch wallets in my extension?

The app detects the mismatch and clears the session immediately, prompting you to sign in with the new wallet. Otherwise, you'd silently fail to see your own data (because the JWT no longer matches the connected wallet).

---

## Where things stand + roadmap

### Is this live?

Yes — tendr.bid is running end-to-end on Solana devnet today. Every flow described in these docs (sealed bidding, decrypt, award, fund, milestones, disputes, on-chain reputation) works against the deployed program. Production mainnet deployment is planned following the Colosseum Frontier review cycle, alongside an opt-in KYC layer for buyers and providers who want one and additional mobile-UI polish.

### What's "intentionally not here yet"?

- **KYC / KYB.** Pseudonymous tier 0 only today; an opt-in verified tier is on the mainnet roadmap.
- **Encrypted RFP scope.** Schema-prepared but not wired through the UI yet.
- **Fully blind bidding** (buyer can't see who bid even at reveal). Conflicts with vetting; future toggle.
- **Cross-program reputation portability.** Reputation lives on tendr.bid's program today; a v2 attestation primitive can mirror it to a generic on-chain registry.
- **Mainnet.** Devnet today; mainnet planned post-Colosseum Frontier review.

### Where's the source code?

[github.com/0xharp/tender](https://github.com/0xharp/tender) — Anchor program in `programs/tender/`, web app in `apps/web/`, canonical docs in `docs/`.

### How can I contribute?

Open an issue or PR on GitHub. The codebase is MIT-licensed.
