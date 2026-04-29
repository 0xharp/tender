/**
 * Derive a deterministic X25519 keypair for a provider's bid encryption.
 *
 * One key per wallet (no per-RFP nonce): same wallet always produces the same
 * X25519 keypair. A single wallet signature unlocks decryption of every bid
 * the provider has ever placed.
 *
 * Domain-separated from the buyer's RFP keypair derivation so a wallet that's
 * both buyer and provider produces distinct keys per role.
 *
 * Same security argument as derive-rfp-keypair:
 *   - ed25519 signing is deterministic (RFC 8032)
 *   - wallet refuses to sign without explicit user approval per call
 *   - prefix is unique to this app + role
 *
 * Wallet anti-phishing note: Phantom rejects signMessage requests where the
 * bytes look like a Solana transaction. We use a multi-line UTF-8 message
 * starting with a clear app banner — same approach as buyer derivation.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const PROVIDER_KEY_DOMAIN = 'tender-provider-key-v1';

const enc = new TextEncoder();

export interface DerivedProviderKeypair {
  x25519PrivateKey: Uint8Array;
  x25519PublicKey: Uint8Array;
}

/**
 * Build the human-readable signable message. Constant per app version —
 * same wallet produces the same signature, hence the same keypair.
 */
export function deriveProviderSeedMessage(): Uint8Array {
  const text = `Tender — derive provider bid-decryption keypair (${PROVIDER_KEY_DOMAIN})

This signature deterministically derives an X25519 keypair you use to read your own sealed bids back. Same wallet produces the same keypair every time.

This is NOT a transaction. No funds will move and nothing will be sent on-chain.`;
  return enc.encode(text);
}

export function deriveProviderKeypair(walletSignature: Uint8Array): DerivedProviderKeypair {
  if (walletSignature.byteLength !== 64) {
    throw new Error(
      `wallet signature must be 64 bytes (ed25519), got ${walletSignature.byteLength}`,
    );
  }
  const seed = sha256(walletSignature);
  return {
    x25519PrivateKey: seed,
    x25519PublicKey: x25519.getPublicKey(seed),
  };
}
