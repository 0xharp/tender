# Identity on tendr.bid (SNS)

> How `.sol` names work in tendr.bid, and — critically — what this layer does NOT change about the privacy guarantees you get from the rest of the system. SNS is a display-layer enhancement for already-public wallets. It never resolves identities that the privacy model is supposed to keep sealed.

## Why have an identity layer at all

A procurement marketplace runs on trust signals. Buyers want to know who's bidding so they can decide whom to award; providers want a stable, portable handle for their reputation that travels with their wallet across every product they ever interact with. Wallet hashes (`4xRC…dN3n`) work for crypto-natives but actively work against trust-building for everyone else.

[SNS (Solana Name Service)](https://www.sns.id/) is the canonical Solana naming primitive. A `.sol` name maps to a wallet address. That mapping is public, decentralized, and on chain — anyone can resolve it without needing tendr.bid (or any other product) to be online. tendr.bid is one of many products that read SNS; we don't own the data.

## What you'll see

Every surface where tendr.bid currently shows a wallet hash now shows the wallet's `.sol` name when one is set:

- Buyer + provider profile pages — `.sol` becomes the page heading; the wallet hash sits secondary.
- The leaderboard — every ranked wallet's `.sol` name in the table cell.
- RFP detail pages — the buyer chip shows `alice.sol` instead of `4xRC…dN3n`.
- Marketplace cards — same.
- The "My projects" workbench — RFP cards labeled by buyer/winner `.sol`.
- Milestone notes — the author of every off-chain note shows up as their `.sol`.
- The wallet popover (top right) — your connected wallet's `.sol` is the badge label.
- The bid composer's "Public bidder list" indicator — *"Anyone scanning this RFP will see your bid was placed by alice.sol"*.

If a wallet has no `.sol` set, the surface gracefully falls back to the existing truncated hash — no broken UI.

## What stays private

This is where the integration matters most: **SNS does not weaken the privacy guarantees the rest of tendr.bid gives you.**

The product's privacy model has three layers (full detail in [privacy-model](/docs/privacy-model)). SNS interacts with each:

### 1. Bid contents — sealed by MagicBlock PER

Bid envelopes (price, scope, milestones, success criteria) are encrypted to the buyer's per-RFP key + the provider's per-wallet key, written into a TEE-gated rollup, and unreadable to anyone — *including the buyer* — until the bid window closes. SNS plays no role here. Bid contents stay sealed exactly as before.

### 2. Bidder identity in default mode (Bid contents private)

In the default privacy mode, bidder wallets are visible on chain — anyone can list "providers who bid on RFP X." SNS just labels those already-public wallets with their `.sol` names. The disclosure surface is unchanged; only the labeling improves.

### 3. Bidder identity in private-bidder mode (Bid contents + identity private)

This is the one with care needed. In private-bidder mode:

- The bid is signed by a per-RFP **ephemeral wallet**, deterministically derived from the provider's main wallet. Ephemerals are freshly-generated, have no on-chain history, and have no `.sol` name (they never will — they're throwaway).
- The provider's main wallet does not appear on chain at bid time. The encrypted envelope carries it, sealed.
- At award time, an Ed25519 binding signature in the `select_bid` transaction reveals the verified main wallet — but only for the WINNER. Losing bidders' main wallets stay sealed forever.

**Where SNS sits in this model:**

- We **never** SNS-resolve the ephemeral bid signer. Even though the resolution would just return `null` (no .sol record), even sending the resolve query would create a metadata trail (HTTP request to SNS RPC keyed to the ephemeral pubkey). Code convention enforces this — see `apps/web/lib/sns/resolve.ts` for the precondition comment, and `apps/web/components/escrow/confirm-dialogs.tsx` for an explicit "INTENTIONALLY NO withSns" comment on the ephemeral signer's HashLink.
- Losing bidders' main wallets are never linked to their bids on chain. SNS resolution can't surface what was never linked.
- Winners' main wallets are revealed via the Ed25519 binding signature at award — same mechanism as before SNS existed. We then render the winner's `.sol` name (if set) on their profile, in the leaderboard, etc. SNS adds zero new disclosure here; it labels public data.

**Net effect**: every bid you submit in private-bidder mode is exactly as private after SNS as it was before. SNS labels public data; it doesn't expand the public surface.

## Verified vs unverified `.sol`

A wallet can "own" a `.sol` name (the SNS account exists with the wallet as owner) without having set that name as their **primary**. Primary status is a separate on-chain record where the wallet says "this is the canonical name I want to be known by." We treat:

- **Primary, non-stale** → display the `.sol` name. The wallet has explicitly opted into this name being its identity.
- **Stale primary** (set under a previous owner of the domain, no longer trusted) → fall back to truncated hash. The SDK gives us a `stale: true` flag we honor.
- **No primary set** (wallet may own names but hasn't picked one as canonical) → fall back to truncated hash. We don't second-guess.

You can set your primary `.sol` from any SNS-aware wallet (Backpack, Phantom, etc.) or from [sns.id](https://www.sns.id/) directly.

## What we don't do

- **No on-chain SNS state.** The Tendr Anchor program doesn't touch SNS accounts. The integration is read-only browser-side.
- **No `.sol` as canonical identifier.** The chain stores wallet pubkeys for everything. SNS is only ever a display label.
- **No SNS-gated bidding.** A wallet without a `.sol` name is treated identically to one with — bidding, reputation, payouts all key off the wallet pubkey.
- **No surfacing of `.sol` for ephemeral bid signers.** Hard-coded into the integration.

## Reference

- `apps/web/lib/sns/resolve.ts` — forward + reverse + bulk-reverse helpers.
- `apps/web/lib/sns/cache.ts` — two-tier cache (in-memory + sessionStorage, TTL).
- `apps/web/lib/sns/hooks.ts` — `useSnsName(wallet)` React hook.
- `apps/web/components/primitives/hash-link.tsx` — `withSns` opt-in prop.
- `apps/web/components/escrow/confirm-dialogs.tsx` — explicit "no withSns" comment on the ephemeral-signer HashLink (the one place where setting it would weaken the privacy property).
- SNS docs: <https://docs.sns.id/dev>
- See [privacy-model](/docs/privacy-model) for the full layered privacy story SNS slots into.
