# tendr.bid

> **End-to-end private RFP procurement on Solana.** Buyers post RFPs, providers commit cryptographically-sealed bids, the buyer picks a winner, escrow settles by milestone. Bid contents are sealed from everyone — including the buyer who posted the RFP — until the bid window closes. Both buyer and bidder identities are optionally hidden behind HD-derived ephemeral wallets funded through Cloak's shielded UTXO pool, with reputation merging into your main wallet only when you explicitly claim it.

**Live on Solana devnet — End-to-End Privacy Enabled RFP Procurement.** Mainnet post Colosseum Frontier & audit review.

[**tendr.bid**](https://tendr.bid) · [@tendrdotbid](https://x.com/tendrdotbid) · [FAQ](docs/faq.md) · [Privacy model](docs/privacy-model.md) · [Lifecycle](docs/lifecycle.md) · [Reputation model](docs/reputation-model.md) · [Anchor program](programs/tender/src)

---

## What's here

A four-piece system, all in this monorepo:

| Path | What it is |
|---|---|
| `programs/tender/` | Anchor v0.32.1 program (Solana devnet, deployed at `GJe2DPcCBja5MLEenV2aeidsNxYavUMmA8eTJz8nSs9Z`). RFPs, sealed-bid commitments, escrow, milestone state machine, on-chain reputation (with claim-based merge from anonymous-mode ephemerals via `attest_buyer_history` + `attest_win`), dispute resolution. |
| `apps/web/` | Next.js 16 + Tailwind 4 web app. Buyer + provider UI for the full lifecycle: create RFP, decrypt-and-bid, award, fund, milestone management, dispute, leaderboard, on-chain rep cards. |
| `apps/ai-sidecar/` | Tiny FastAPI sidecar for AI-assisted RFP scope drafting (optional). |
| `packages/shared/` | Shared TS types (RFP categories, reputation rows, supabase schema). |
| `packages/tender-client/` | Codama-generated TS client for the Anchor program. Don't hand-edit — run `pnpm run generate`. |
| `tests/litesvm/` | Vitest + LiteSVM end-to-end tests for the program (no devnet needed). |
| `docs/` | Canonical reference docs in markdown — the same files render in-app at `/docs/[slug]`. |
| `supabase/migrations/` | Off-chain schema for the human-readable text fields the chain doesn't carry (RFP titles, milestone notes, etc.). |

Source of truth always favors the chain. Supabase only stores text the chain doesn't need to know about.

## The privacy stack (one paragraph)

Each bid is encrypted into two ECIES envelopes (X25519 + XChaCha20-Poly1305) — one to the buyer's per-RFP key, one to the bidder's per-wallet key. The encrypted account is **delegated to MagicBlock's Private Ephemeral Rollup**, where reads are gated by a permission account inside an Intel TDX TEE-backed validator. The only way to decrypt before `bid_close_at` is to compromise the buyer's wallet — there is no buyer-side "peek" path because the on-chain `open_reveal_window` instruction, which adds the buyer to the permission set, reverts if `clock.unix_timestamp < rfp.bid_close_at`. Privacy is configurable on two orthogonal axes per RFP: **bidder identity** (each bid signed by an HD-derived ephemeral, funded via **Cloak's shielded UTXO pool**) and **buyer identity** (the RFP itself signed by an HD-derived ephemeral, also Cloak-funded). One master signature per session derives every ephemeral you'll need across both roles via HKDF — buyers, bidders, funding sub-wallets, refund/payout sub-wallets — no encrypted-file storage, no per-action wallet popup spam. Activity on these ephemerals accrues to per-eph reputation PDAs; a separate **claim ix** (`attest_buyer_history` for buyers, `attest_win` for providers) merges that history into the main wallet's public reputation in one transaction, on the user's terms, after the project completes. **Losing private bidders' main wallets stay sealed forever, even after their winning peer claims.**

Full detail in [docs/privacy-model.md](docs/privacy-model.md). Lifecycle map in [docs/lifecycle.md](docs/lifecycle.md). Reputation + claim flow in [docs/reputation-model.md](docs/reputation-model.md).

---

## Quickstart

### Try the live demo (no install needed)

Visit **[tendr.bid](https://tendr.bid)** — already deployed on Solana devnet against the Anchor program above. To walk through a full RFP lifecycle you'll need:

1. **A Solana wallet switched to Devnet network.**
   - Phantom: `Settings → Developer Settings → Change Network → Devnet`
   - Backpack: `Settings → Network → Devnet`
2. **Devnet SOL for transaction fees** — airdrop ~2 SOL from [faucet.solana.com](https://faucet.solana.com/).
3. **Cloak Mock USDC for RFP funding** — claim from [devnet.cloak.ag/privacy/faucet](https://devnet.cloak.ag/privacy/faucet). Tender uses Cloak's mock USDC (mint `61ro7AExqfk4dZYoCyRzTahahCC2TdUUZ4M5epMPunJf`) so RFP escrow funding flows through Cloak's shielded UTXO pool when in anonymous-buyer mode.

Once funded, walk the full lifecycle: claim your `.tendr.sol` identity → create an RFP (try fully sealed mode) → submit a bid from a second wallet → close the bid window → decrypt → award → fund escrow → milestone release → claim reputation.

> Hackathon judges: same setup applies. The mock USDC step is what unlocks end-to-end RFP funding.

### Prerequisites (for local development)

- Node ≥ 22, pnpm ≥ 10
- Rust + Solana CLI 1.18+ (only if you want to build/test the program)
- Anchor 0.32.1 (only for program work)

### Run the web app locally against devnet

The program is already deployed on devnet at the address above; you don't need to build the program just to run the UI.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # fill in supabase URL + anon key
pnpm --filter @tender/web dev                  # http://localhost:3000
```

Wallet + faucet setup is the same as the **Try the live demo** section above (devnet network, devnet SOL, Cloak mock USDC).

### Build the program

```bash
anchor build                       # builds the SBF binary + IDL
pnpm run generate                  # regenerates packages/tender-client from the IDL
anchor deploy --provider.cluster devnet   # deploy to devnet (you need program upgrade authority)
```

### Run tests

```bash
pnpm test                          # all packages (turbo)
pnpm --filter @tender/litesvm-tests test   # program-only LiteSVM tests
pnpm --filter @tender/web exec vitest run  # crypto + helpers
```

### Apply supabase migrations

```bash
# Manually via psql or the Supabase CLI
psql "$DATABASE_URL" -f supabase/migrations/0008_milestone_notes.sql
```

(Migrations are append-only and idempotent — re-running is safe.)

---

## What works end-to-end on devnet

- ✅ Create RFP — public OR anonymous (HD-derived ephemeral buyer, funded via Cloak's shielded pool)
- ✅ Submit sealed bid — public OR anonymous (HD-derived bidder ephemeral, funded via Cloak's shielded pool)
- ✅ Four orthogonal privacy combinations: public buyer + public bidder, public buyer + private bidder, private buyer + public bidder, fully sealed (private buyer + private bidder)
- ✅ HD-keychain unified derivation — one master signature per session derives every ephemeral role (buyers, bidders, funding sub-wallets, refund/payout sub-wallets) via HKDF. Cross-tab sync via BroadcastChannel; sessionStorage cache for hard-reload survival.
- ✅ Close bidding (permissionless, after `bid_close_at`)
- ✅ Decrypt bids client-side, optionally reveal sealed reserve, award winner with binding-sig
- ✅ Fund project (USDC into escrow ATA) — buyer ephemeral funds via Cloak's shielded pool when in anonymous-buyer mode
- ✅ Per-milestone start / submit / accept / request-changes / reject — every post-award action signs with the matching ephemeral when the RFP is in private-bidder or private-buyer mode (no main-wallet leak via tx fee payer)
- ✅ Dispute path: propose split (both sides), default 50/50 after cool-off
- ✅ Cancel-with-notice / cancel-with-penalty / cancel-late paths
- ✅ Auto-release after review window
- ✅ Buyer-ghosted (permissionless after funding deadline)
- ✅ Expire-RFP (permissionless after reveal deadline if buyer never awarded)
- ✅ On-chain BuyerReputation + ProviderReputation, leaderboard + per-wallet profile pages
- ✅ Claim-based reputation merge — `attest_buyer_history` (private-buyer) and `attest_win` (private-bidder) merge an ephemeral's accrued reputation into the user's main wallet rep in a single ix. Idempotent per RFP/bid, gated to `Completed` status, surfaced as inline "Claim reputation" CTAs on the dashboard
- ✅ Distinct terminal states — `Completed` (work delivered) vs `Cancelled` (all milestones refunded, no work) — so buyer reputation can't be inflated by serial cancellation
- ✅ "Your projects" workbench with next-action surfacing per RFP, including time-gated escape hatches (auto-release, mark-ghosted, default-50/50, cancel-late)
- ✅ Off-chain milestone notes (deliverable links, change requests) attached to on-chain transitions
- ✅ Identity layer via SNS — `.sol` names render across every wallet display surface (profiles, leaderboard, RFP cards, milestone notes, wallet popover). Privacy-safe: never resolves ephemeral signers; expands zero new public-identity surface. See `docs/identity.md`.
- ✅ In-app docs at `/docs/[slug]` rendering the same `.md` files GitHub serves — single source of truth
- ✅ QVAC Private AI surfaces — RFP scope drafting, structured bid drafting (price + timeline + milestones populated end-to-end), and post-decrypt bid comparison — running on a [QVAC](https://qvac.tether.io/) sidecar deployed to a dedicated [Nosana](https://nosana.com/) GPU. Browser hits the sidecar directly via env var; Tendr's app servers never see prompts or bid plaintexts, and no closed AI provider (OpenAI, Anthropic, etc.) is in the pipeline. Open-weight model (Qwen3 4B Q4_K_M). See `docs/ai.md`.

---

## Architecture in one screen

```
┌──────────────────────────┐    delegate    ┌─────────────────────────────┐
│  Solana base layer       │ ─────────────▶ │  MagicBlock Private ER      │
│  (devnet)                │                │  (Intel TDX TEE-backed)     │
│                          │ ◀───────────── │                             │
│  - Rfp PDAs              │   undelegate   │  - BidCommit accounts       │
│  - Milestone PDAs        │   (on win)     │    (sealed bid envelopes)   │
│  - Escrow ATA (USDC)     │                │  - Permission accounts gate │
│  - BuyerReputation /     │                │    reads inside the TEE     │
│    ProviderReputation    │                │                             │
└──────────────────────────┘                └─────────────────────────────┘
            ▲                                              ▲
            │                                              │
            ▼                                              │
┌──────────────────────────┐                              │
│  Cloak shielded pool     │                              │
│                          │── ZK-shielded transfer ──────┘
│                          │   funds buyer + bidder
│  - HD-derived ephemerals │   ephemerals in private mode
│    (HKDF from main wallet│
│    via @noble/hashes)    │
└──────────────────────────┘

         Browser
            │
            ▼
┌──────────────────────────┐                ┌─────────────────────────────┐
│  Next.js 16 (apps/web)   │                │  Supabase (off-chain text)  │
│                          │ ─────────────▶ │  - rfps.title, scope_summary│
│  - Codama-generated TS   │                │  - providers.display_name   │
│  - @solana/kit signing   │                │  - milestone_notes (append- │
│  - SIWS session JWT      │                │    only context per ix)     │
│  - ECIES (X25519 +       │                └─────────────────────────────┘
│    XChaCha20-Poly1305)   │
└──────────────────────────┘
```

## Repository layout

```
tender/
├── README.md                  ← you are here
├── docs/
│   ├── privacy-model.md       ← canonical reference, also rendered at /docs/privacy-model
│   ├── lifecycle.md
│   └── reputation-model.md
├── programs/tender/
│   ├── src/lib.rs             ← #[program] entry
│   ├── src/state/             ← Rfp, BidCommit, MilestoneState, Escrow, BuyerReputation, ProviderReputation
│   └── src/instructions/      ← one file per ix (rfp_create, commit_bid_init, ..., resolve_dispute)
├── apps/web/
│   ├── app/                   ← Next.js app router (Next 16 + Turbopack)
│   ├── components/
│   ├── lib/
│   │   ├── solana/            ← chain reads, codama-friendly helpers
│   │   ├── crypto/            ← ECIES + key derivation
│   │   ├── sdks/              ← MagicBlock + Cloak wrappers
│   │   ├── escrow/            ← milestone-flow ix builders
│   │   └── docs/              ← /docs/* loader
│   └── AGENTS.md              ← Next 16 specifics worth reading before edits
├── apps/ai-sidecar/           ← FastAPI helper for RFP scope drafting (optional)
├── packages/
│   ├── shared/                ← TS types (RFP categories, supabase rows)
│   └── tender-client/         ← Codama-generated client (don't hand-edit)
├── tests/litesvm/             ← Vitest + LiteSVM e2e program tests
├── supabase/migrations/       ← off-chain schema (rfps text, milestone_notes, RLS)
├── Anchor.toml
└── pnpm-workspace.yaml
```

## Acknowledgements

- **MagicBlock** for the Private Ephemeral Rollup primitives + the responsive support team.
- **Cloak** for the shielded UTXO pool that makes private-mode bids cryptographically unlinkable.
- **SNS (Solana Name Service)** for the identity layer — every wallet renders as `<handle>.tendr.sol` across the app.
- **QVAC (by Tether)** for the open-source AI infrastructure that powers our Private AI sidecar — bid drafting + comparison run on QVAC, never on closed AI providers.
- **Nosana** for the dedicated devnet GPU credits that host the QVAC sidecar.
- **Colosseum + Solana Foundation** for the Frontier program.
- **Superteam Earn** for the "Ideas → Prompt → Production" grant.

## License

MIT — see `LICENSE`.
