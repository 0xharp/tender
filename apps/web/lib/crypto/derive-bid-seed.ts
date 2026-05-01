/**
 * Provider-side `bid_pda_seed` derivation for L1 (BuyerOnly) RFPs.
 *
 * In L0 (Public), the bid PDA seed equals the provider's wallet bytes — anyone
 * can enumerate program accounts to learn who bid on which RFP. In L1, the
 * seed is opaque to outside observers (`sha256(walletSig(domain || rfp_nonce))`)
 * but deterministically re-derivable by the provider from their wallet alone.
 *
 * The signed message is human-readable so wallets render it cleanly (Phantom's
 * anti-phishing rejects bytes that start with low-magnitude bytes like 0x74,
 * see PLAN-DELTA Day 3 notes — `T` is safe).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const DOMAIN_PREFIX = 'tender-bid-seed-v1';

/** Build the human-readable message the provider's wallet signs. */
export function deriveBidSeedMessage(rfpNonce: Uint8Array): Uint8Array {
  if (rfpNonce.byteLength !== 8) {
    throw new Error(`rfp_nonce must be 8 bytes, got ${rfpNonce.byteLength}`);
  }
  const text =
    `Tender — derive private bid PDA seed.\n` +
    `\n` +
    `Domain: ${DOMAIN_PREFIX}\n` +
    `RFP nonce: 0x${bytesToHex(rfpNonce)}\n` +
    `\n` +
    `Signing this lets you bid privately on this RFP. The signature is local —\n` +
    `no funds move. The signature does NOT authorize a transaction.`;
  return new TextEncoder().encode(text);
}

/** Compute the 32-byte PDA seed from the wallet's signature over the message. */
export function deriveBidPdaSeed(walletSignature: Uint8Array): Uint8Array {
  return sha256(walletSignature);
}

/**
 * Convenience: full client-side derivation pipeline.
 *
 *   bid_pda_seed = sha256(walletSig("tender-bid-seed-v1" || rfp_nonce_text))
 */
export async function signBidPdaSeed(
  rfpNonce: Uint8Array,
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>,
): Promise<Uint8Array> {
  const message = deriveBidSeedMessage(rfpNonce);
  const { signature } = await signMessage({ message });
  return deriveBidPdaSeed(signature);
}
