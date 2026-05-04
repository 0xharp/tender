# Identity on tendr.bid (SNS)

> Every Tender user gets a `.tendr.sol` identity at signup, minted by us under our own SNS parent on devnet. Names appear everywhere a wallet does — leaderboard, profiles, RFP cards, share-cards. The privacy model is unchanged: we never resolve names for ephemeral bid signers, and SNS labels only already-public wallets.

## Why have an identity layer at all

A procurement marketplace runs on trust signals. Buyers want to know who's bidding so they can decide whom to award; providers want a stable, portable handle for their reputation that travels across every product they use. Wallet hashes (`4xRC…dN3n`) work for crypto-natives but actively work against trust-building for everyone else.

[SNS (Solana Name Service)](https://www.sns.id/) is the canonical Solana naming primitive — `.sol` names map to wallets via on-chain accounts that any product on Solana can read. Tendr's identity layer sits on top of SNS: rather than asking each user to bring (or buy) their own `.sol`, **Tendr issues every signed-in wallet a free `<handle>.tendr.sol` subdomain**, owned by the user and resolvable by any SNS-aware app.

## The claim flow

The first time you sign in to tendr.bid, a small modal asks you to pick a handle (3-20 chars, alphanumeric + hyphens). Click "Suggest" for a random one if you don't want to think about it. Click "Claim" — and that's it. **No wallet popup, no signature.** Tendr's parent-domain owner signs the mint server-side and assigns ownership to your wallet in the same transaction. We pay the on-chain rent.

Your `<handle>.tendr.sol` then surfaces everywhere a wallet was previously rendered as a hash:

- Buyer + provider profile pages — `.tendr.sol` becomes the page heading.
- The leaderboard — every ranked wallet's `.tendr.sol` in the table.
- RFP detail pages — the buyer chip shows your name.
- The "My projects" workbench — RFP cards labeled by buyer/winner identity.
- Milestone notes — the author of every off-chain note.
- The wallet popover (top right) — your connected wallet's identity is the badge label.
- OG share cards — `https://tendr.bid/providers/yourname.tendr.sol` unfurls on X with `yourname.tendr.sol` as the hero label.

If you haven't claimed yet, surfaces fall back to the truncated hash — no broken UI.

## How the subdomain is owned on chain

The on-chain SPL Name Service account backing `<handle>.tendr.sol` has an `owner` field set to the user's wallet at mint time. Tendr's parent-owner keypair signs the create + assignment in one tx; after that, the user's wallet is the canonical owner and Tendr cannot move the subdomain. We absorb the per-subdomain rent so users pay nothing.

## How identity and reputation relate

tendr.bid maintains two on-chain reputation account types — `BuyerReputation` and `ProviderReputation` — one per **wallet pubkey**, lazily initialized on first award. They track funded RFPs, completed projects, disputes, ghosted/cancelled milestones, and gross USDC volume. Full schema in [reputation-model](/docs/reputation-model).

The `.tendr.sol` identity layer sits above this: every UI surface that renders a wallet (leaderboard, profile pages, RFP cards, milestone notes, OG share-cards, wallet popover) resolves `wallet → <handle>.tendr.sol` and shows the name. Reputation lookups still key off the wallet pubkey under the hood — the SNS layer just makes the *display* humanly recognizable instead of a 44-char base58 hash.

## What stays private

This is where the integration matters most: **SNS does not weaken the privacy guarantees the rest of tendr.bid gives you.**

The product's privacy model has three layers (full detail in [privacy-model](/docs/privacy-model)). SNS interacts with each:

### 1. Bid contents — sealed by MagicBlock PER

Bid envelopes (price, scope, milestones, success criteria) are encrypted to the buyer's per-RFP key + the provider's per-wallet key, written into a TEE-gated rollup, and unreadable to anyone — *including the buyer* — until the bid window closes. SNS plays no role here. Bid contents stay sealed exactly as before.

### 2. Bidder identity in default mode (Bid contents private)

In the default privacy mode, bidder wallets are visible on chain — anyone can list "providers who bid on RFP X." SNS just labels those already-public wallets with their `.tendr.sol` names. The disclosure surface is unchanged; only the labeling improves.

### 3. Bidder identity in private-bidder mode (Bid contents + identity private)

This is the one with care needed. In private-bidder mode:

- The bid is signed by a per-RFP **ephemeral wallet**, deterministically derived from the provider's main wallet. Ephemerals are freshly-generated, have no on-chain history, and have no `.tendr.sol` name (they never will — they're throwaway).
- The provider's main wallet does not appear on chain at bid time. The encrypted envelope carries it, sealed.
- At award time, an Ed25519 binding signature in the `select_bid` transaction reveals the verified main wallet — but only for the WINNER. Losing bidders' main wallets stay sealed forever.

**Where SNS sits in this model:**

- We **never** SNS-resolve the ephemeral bid signer. Even though the resolution would just return `null` (no claim), even sending the resolve query would create a metadata trail (HTTP request to SNS RPC keyed to the ephemeral pubkey). Code convention enforces this — see `apps/web/lib/sns/resolve.ts` for the precondition comment, and `apps/web/components/escrow/confirm-dialogs.tsx` for an explicit "INTENTIONALLY NO withSns" comment on the ephemeral signer's HashLink.
- The reverse-resolve mechanism is also bounded: `useSnsName(wallet)` queries a `getProgramAccounts` filter scoped to `parent == tendr.sol AND owner == wallet`. Even if accidentally called for an ephemeral, it returns null (ephemerals aren't tendr-issued) and never touches the global SNS primary-domain mechanism.
- Losing bidders' main wallets are never linked to their bids on chain. SNS resolution can't surface what was never linked.
- Winners' main wallets are revealed via the Ed25519 binding signature at award — same mechanism as before SNS existed. We then render the winner's `.tendr.sol` (if claimed) on their profile, in the leaderboard, etc. SNS adds zero new disclosure here; it labels public data.

**Net effect**: every bid you submit in private-bidder mode is exactly as private after SNS as it was before. SNS labels public data; it doesn't expand the public surface.

## What about my existing `.sol`?

The whole identity layer is **powered by [SNS (Solana Name Service)](https://www.sns.id/)** — every `<handle>.tendr.sol` is a real SNS subdomain under our parent, owned by your wallet, and resolvable by any SNS-aware app on Solana. We just scope the *display* in tendr.bid to names under our parent: a wallet's reverse-resolution here returns `<handle>.tendr.sol` if you've claimed one, and falls back to the truncated wallet hash if you haven't — even if you own and use a different `.sol` as your global SNS primary elsewhere. The intent is to give every Tendr user an identity from day one without needing them to bring their own; if you also want your tendr identity to be your global SNS primary, you can wire that up with standard SNS tooling, but it's not required.

## What we don't do

- **No on-chain SNS state in the Tender program.** The Tendr Anchor program touches no SNS accounts. The integration sits entirely in the web layer.
- **No `.sol` as canonical identifier.** The chain stores wallet pubkeys for every Tender record (RFPs, bids, escrow, reputation). SNS is only ever a display label.
- **No SNS-gated bidding.** A wallet without a `.tendr.sol` name is treated identically to one with — bidding, reputation, payouts all key off the wallet pubkey.
- **No surfacing of `.sol` for ephemeral bid signers.** Hard-coded into the integration via the `withSns` opt-in default + the parent-bounded resolver.
- **No second user signature for the claim.** Tender's parent-owner keypair signs the mint server-side; the user just clicks Claim.

## Reference

- `apps/web/lib/sns/devnet/` — devnet-specific resolver, mint adapter, handle validation, suggester.
- `apps/web/lib/sns/resolve.ts` — public forward / reverse / bulk-reverse helpers (kit-native, scoped to tendr parent).
- `apps/web/lib/sns/cache.ts` — two-tier cache (in-memory + sessionStorage, 24h positive / 10m negative TTL).
- `apps/web/lib/sns/hooks.ts` — `useSnsName(wallet)` React hook.
- `apps/web/components/identity/claim-identity-modal.tsx` — onboarding modal.
- `apps/web/components/identity/identity-modal-provider.tsx` — global provider, auto-opens on first sign-in.
- `apps/web/components/primitives/hash-link.tsx` — `withSns` opt-in prop.
- `apps/web/components/escrow/confirm-dialogs.tsx` — explicit "no withSns" comment on the ephemeral-signer HashLink (the one place where setting it would weaken the privacy property).
- `apps/web/app/api/identity/claim/route.ts` — server-side mint endpoint.
- `apps/web/scripts/register-tendr-devnet.mjs` — one-off `tendr.sol` registration script.
- SNS docs: <https://docs.sns.id/dev>
- See [privacy-model](/docs/privacy-model) for the full layered privacy story SNS slots into.
