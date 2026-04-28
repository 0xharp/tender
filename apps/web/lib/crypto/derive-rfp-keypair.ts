/**
 * Derive a deterministic X25519 keypair for a buyer's specific RFP.
 *
 * Pattern: the buyer's wallet ed25519-signs a domain-separated message
 * (`prefix || rfp_nonce`); we sha256 the resulting signature into a 32-byte
 * X25519 secret. Same wallet + same nonce → same keypair, every time.
 *
 * This means the buyer never needs to store the X25519 private key — they can
 * recover it on demand by re-signing the same message with their wallet.
 *
 * Security relies on:
 *   - ed25519 signatures being deterministic (RFC 8032)
 *   - the wallet refusing to sign without explicit user approval per call
 *   - the prefix `KEY_DERIVATION_PREFIX` having no other use in the app
 *     (so a malicious site can't trick the wallet into producing this signature)
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const KEY_DERIVATION_PREFIX = 'tender-rfp-key-v1';
export const RFP_NONCE_BYTES = 8;

const enc = new TextEncoder();
const PREFIX_BYTES = enc.encode(KEY_DERIVATION_PREFIX);

export interface DerivedRfpKeypair {
  x25519PrivateKey: Uint8Array; // 32 bytes — never leaves the browser
  x25519PublicKey: Uint8Array; // 32 bytes — goes on-chain in Rfp.buyer_encryption_pubkey
}

/** Build the message that the wallet signs to derive the RFP keypair. */
export function deriveSeedMessage(rfpNonce: Uint8Array): Uint8Array {
  if (rfpNonce.byteLength !== RFP_NONCE_BYTES) {
    throw new Error(`rfp_nonce must be ${RFP_NONCE_BYTES} bytes`);
  }
  const buf = new Uint8Array(PREFIX_BYTES.length + rfpNonce.length);
  buf.set(PREFIX_BYTES, 0);
  buf.set(rfpNonce, PREFIX_BYTES.length);
  return buf;
}

/**
 * Pure function — derive the keypair from a wallet's ed25519 signature.
 *
 * @param walletSignature  64-byte ed25519 signature returned by `wallet.signMessage(deriveSeedMessage(rfpNonce))`
 */
export function deriveRfpKeypair(walletSignature: Uint8Array): DerivedRfpKeypair {
  if (walletSignature.byteLength !== 64) {
    throw new Error(
      `wallet signature must be 64 bytes (ed25519), got ${walletSignature.byteLength}`,
    );
  }
  const seed = sha256(walletSignature);
  const x25519PrivateKey = seed; // 32 bytes; @noble x25519 clamps internally
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey);
  return { x25519PrivateKey, x25519PublicKey };
}
