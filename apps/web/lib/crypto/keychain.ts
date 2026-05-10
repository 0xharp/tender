/**
 * Tender HD keychain — single master signature unlocks every per-role
 * ephemeral the user has across both buyer and provider activity.
 *
 * Why this exists
 * ---------------
 * Today, both buyer and provider workflows derive ephemeral keypairs
 * per-RFP via separate signMessage flows (`derive-rfp-keypair.ts`,
 * `derive-ephemeral-bid-wallet.ts`). That works, but two pain points:
 *
 *   1. Provider has to revisit each RFP and sign just to discover
 *      whether they bid there — a fresh laptop starts blind to its own
 *      bid history because the per-RFP signature is the only way to
 *      compute the ephemeral pubkey to memcmp against the chain.
 *
 *   2. Buyer "anonymous mode" (v2 work) needs the same enumeration
 *      primitive on the buyer side — without an HD scheme, we'd have
 *      to either store the main↔ephemeral mapping server-side
 *      (defeats the privacy point) or sign per-RFP to discover.
 *
 * The keychain replaces both with a single HKDF-based derivation tree
 * rooted in one signMessage call. Same security properties as today's
 * per-RFP derivations, but `n` keys for the price of `1` user prompt.
 *
 * Design properties
 * -----------------
 *  - Deterministic: ed25519 signMessage is deterministic per RFC 8032,
 *    so the same wallet → same signature → same master seed → same
 *    ephemerals on every device, every session.
 *  - Domain-prefixed message: the wallet popup shows the user the
 *    Tender app banner + a "this is not a transaction" warning. The
 *    text is the user's first defense against phishing the master sign
 *    from another origin. (SIWS-format domain binding is a v3
 *    hardening on top of this baseline.)
 *  - Role-separated subtrees: `buyer:n`, `bidder:n`, `fund:<rfp>:<k>`,
 *    `refund:n`, `payout:n` are independent HKDF outputs — no
 *    statistical relationship between any two derived keys, even from
 *    the same master.
 *  - Pure module: no wallet I/O here. Caller does the signMessage,
 *    feeds the 64-byte signature in, gets keypairs out. Caching the
 *    derived master seed across the tab session is the caller's job.
 *
 * Compromise model
 * ----------------
 * If an attacker tricks the user into signing the master message from
 * a hostile origin, they can derive every ephemeral and act as buyer/
 * bidder/refund-receiver on every Tender RFP the user has touched.
 * They cannot move funds out of the main wallet itself — that requires
 * `mainWalletPrivKey`, not a single signature output. Mitigation lives
 * in the message text + (eventually) SIWS domain enforcement.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Keypair } from '@solana/web3.js';

export const KEYCHAIN_DOMAIN = 'tender-keychain-v1';

/** Roles correspond to the on-chain identity each ephemeral holds. */
export type KeychainRole = 'buyer' | 'bidder' | 'fund' | 'refund' | 'payout';

const enc = new TextEncoder();

/**
 * Bytes the user signs to unlock the keychain. Deterministic — same
 * wallet always produces the same signature, hence the same master
 * seed, on every device.
 *
 * The text is human-readable so the wallet's signMessage popup shows
 * the user what they're approving. Domain banner + non-transaction
 * disclaimer + "do not sign from another site" warning.
 */
export function deriveKeychainSeedMessage(): Uint8Array {
  const text = `Tender — unlock your private procurement keychain (${KEYCHAIN_DOMAIN})

Signing this derives the deterministic keys for every anonymous RFP and sealed bid you touch on Tender. One signature per device per session covers both your buyer and provider activity.

This is NOT a transaction. No funds will move and nothing is sent on-chain. Only sign this prompt on tendr.bid — never on any other site.`;
  return enc.encode(text);
}

/**
 * Compress the 64-byte wallet signature down to a 32-byte master seed.
 * sha256 is sufficient — we only need a uniformly-distributed input for
 * HKDF, and the wallet signature already has full entropy.
 */
export function deriveMasterSeed(walletSignature: Uint8Array): Uint8Array {
  if (walletSignature.byteLength !== 64) {
    throw new Error(
      `wallet signature must be 64 bytes (ed25519), got ${walletSignature.byteLength}`,
    );
  }
  return sha256(walletSignature);
}

/**
 * Build the HKDF info string for a given role + arbitrary suffix.
 *
 * Index/suffix is a string so the same helper handles both numeric
 * indices (buyer, bidder, refund, payout) and composite keys (fund
 * uses `<rfp_pda>:<seq>` so a single RFP can have multiple fund txs
 * each with its own ephemeral, useful if a fund attempt fails and we
 * need to retry with a fresh signer).
 */
function infoFor(role: KeychainRole, suffix: string): Uint8Array {
  return enc.encode(`${KEYCHAIN_DOMAIN}/${role}/${suffix}`);
}

const SALT = enc.encode(`${KEYCHAIN_DOMAIN}-hkdf-salt`);

/**
 * Low-level: derive a 32-byte ed25519 seed for a (role, suffix) slot.
 * Pure function — same inputs always yield the same output.
 *
 * Exposed so tests can pin the byte-level outputs and so a caller can
 * skip the Keypair construction overhead when they only need the
 * pubkey (e.g. enumeration / memcmp queries).
 */
export function deriveSlotSeed(
  masterSeed: Uint8Array,
  role: KeychainRole,
  suffix: string,
): Uint8Array {
  if (masterSeed.byteLength !== 32) {
    throw new Error(`master seed must be 32 bytes, got ${masterSeed.byteLength}`);
  }
  return hkdf(sha256, masterSeed, SALT, infoFor(role, suffix), 32);
}

/**
 * Construct a Solana Keypair from a (role, suffix) slot.
 *
 * Async because `@solana/web3.js` is dynamically imported — keeps the
 * web3.js dependency out of the lib's static graph for callers that
 * only need pubkeys (which Solana Kit can produce without web3.js).
 */
async function deriveKeypairFor(
  masterSeed: Uint8Array,
  role: KeychainRole,
  suffix: string,
): Promise<Keypair> {
  const seed = deriveSlotSeed(masterSeed, role, suffix);
  const { Keypair } = await import('@solana/web3.js');
  return Keypair.fromSeed(seed);
}

/* -------------------------------------------------------------------------- */
/* Per-role convenience wrappers — each role formats its suffix consistently.  */
/* -------------------------------------------------------------------------- */

/**
 * Buyer ephemeral that owns an `Rfp` account in private buyer mode.
 * One per private RFP; index `n` is allocated by `nextBuyerIndex`
 * via on-chain memcmp (see `enumerateOwnedRfps`).
 */
export async function deriveBuyerEphemeral(
  masterSeed: Uint8Array,
  index: number,
): Promise<Keypair> {
  return deriveKeypairFor(masterSeed, 'buyer', String(index));
}

/**
 * Bidder ephemeral that signs sealed bids in private-bidder mode.
 * Replaces the per-RFP signMessage derivation today — single master
 * sign covers all bids, enumerable via memcmp on `bid.provider`.
 */
export async function deriveBidderEphemeral(
  masterSeed: Uint8Array,
  index: number,
): Promise<Keypair> {
  return deriveKeypairFor(masterSeed, 'bidder', String(index));
}

/**
 * Funder ephemeral that signs `fund_project` for a specific RFP.
 * Single-use per fund attempt: `seq=0` for first attempt, increment
 * on retry. Lets us recover funds locked in a stuck ephemeral by
 * re-deriving the same key from the master.
 */
export async function deriveFundEphemeral(
  masterSeed: Uint8Array,
  rfpPda: string,
  seq: number,
): Promise<Keypair> {
  return deriveKeypairFor(masterSeed, 'fund', `${rfpPda}:${seq}`);
}

/**
 * Refund destination ephemeral. The buyer hands this ATA's owner key
 * to refund-emitting ixs (cancel / dispute / late-cancel) so the
 * refund lands at an address decorrelated from the main wallet.
 */
export async function deriveRefundEphemeral(
  masterSeed: Uint8Array,
  index: number,
): Promise<Keypair> {
  return deriveKeypairFor(masterSeed, 'refund', String(index));
}

/**
 * Payout destination ephemeral for the provider side. Mirrors the
 * existing payout_destination from the L1 hybrid plan, but derived
 * from the master keychain instead of per-RFP.
 */
export async function derivePayoutEphemeral(
  masterSeed: Uint8Array,
  index: number,
): Promise<Keypair> {
  return deriveKeypairFor(masterSeed, 'payout', String(index));
}
