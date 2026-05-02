/**
 * Sealed-bid ECIES - X25519 ECDH + XChaCha20-Poly1305.
 *
 * Wire format of an encrypted bid blob:
 *   | ephemeralPub (32) | nonce (24) | ciphertext (n + Poly1305 tag (16)) |
 *
 * Security properties:
 *   - Confidentiality: only the buyer (X25519 priv holder) can decrypt
 *   - Integrity: Poly1305 tag inside the AEAD ciphertext + on-chain commit_hash
 *   - Forward secrecy per bid: ephemeral X25519 keypair generated for each encryption
 *   - Bidder anonymity from peers: peers see only commit_hash (random-looking 32 bytes)
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { commitHash } from './commit';

export const X25519_KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;

export interface EncryptedBid {
  /** Concatenated wire format: ephemeralPub || nonce || ciphertext+tag */
  blob: Uint8Array;
  /** sha256(blob) - committed on-chain via commit_bid */
  commitHash: Uint8Array;
  /** ephemeral pubkey (32 bytes) - also at the head of `blob`, exposed for indexing */
  ephemeralPub: Uint8Array;
}

/**
 * Derive the symmetric AEAD key from the ECDH shared secret + both pubkeys.
 *
 * key = sha256( shared || ephemeralPub || buyerPub )
 *
 * The two pubkeys are mixed in to bind the key to the specific (ephemeral, recipient)
 * pair, defending against unknown-key-share attacks.
 */
function deriveSymmetricKey(
  shared: Uint8Array,
  ephemeralPub: Uint8Array,
  buyerPub: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(shared.length + ephemeralPub.length + buyerPub.length);
  buf.set(shared, 0);
  buf.set(ephemeralPub, shared.length);
  buf.set(buyerPub, shared.length + ephemeralPub.length);
  return sha256(buf);
}

/** Generate a fresh ephemeral X25519 keypair for one bid. */
export function generateEphemeralKeypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

/**
 * Encrypt a bid plaintext to the buyer's X25519 public key.
 *
 * @param plaintext  raw bytes of the bid (typically utf8-encoded JSON)
 * @param buyerX25519Pub  buyer's RFP-specific X25519 public key
 * @param opts.ephemeralPriv  optional override (deterministic encryption for tests)
 * @param opts.nonce  optional override (deterministic encryption for tests)
 */
export function encryptBid(
  plaintext: Uint8Array,
  buyerX25519Pub: Uint8Array,
  opts: { ephemeralPriv?: Uint8Array; nonce?: Uint8Array } = {},
): EncryptedBid {
  if (buyerX25519Pub.byteLength !== X25519_KEY_BYTES) {
    throw new Error(`buyer X25519 pubkey must be ${X25519_KEY_BYTES} bytes`);
  }

  const ephemeralPriv = opts.ephemeralPriv ?? x25519.utils.randomSecretKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const shared = x25519.getSharedSecret(ephemeralPriv, buyerX25519Pub);
  const key = deriveSymmetricKey(shared, ephemeralPub, buyerX25519Pub);
  const nonce = opts.nonce ?? randomBytes(XCHACHA_NONCE_BYTES);
  if (nonce.byteLength !== XCHACHA_NONCE_BYTES) {
    throw new Error(`nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
  }

  const cipher = xchacha20poly1305(key, nonce);
  const ct = cipher.encrypt(plaintext);

  const blob = new Uint8Array(ephemeralPub.length + nonce.length + ct.length);
  blob.set(ephemeralPub, 0);
  blob.set(nonce, ephemeralPub.length);
  blob.set(ct, ephemeralPub.length + nonce.length);

  return {
    blob,
    commitHash: commitHash(blob),
    ephemeralPub,
  };
}

/**
 * Decrypt a bid blob with the buyer's X25519 private key.
 *
 * Verifies: ephemeralPub byte-prefix + Poly1305 tag (via the AEAD).
 * Caller MUST verify the commit_hash separately against the on-chain value.
 */
export function decryptBid(blob: Uint8Array, buyerX25519Priv: Uint8Array): Uint8Array {
  if (buyerX25519Priv.byteLength !== X25519_KEY_BYTES) {
    throw new Error(`buyer X25519 priv must be ${X25519_KEY_BYTES} bytes`);
  }
  if (blob.byteLength < X25519_KEY_BYTES + XCHACHA_NONCE_BYTES + 16) {
    throw new Error('blob too short to contain header + tag');
  }

  const ephemeralPub = blob.slice(0, X25519_KEY_BYTES);
  const nonce = blob.slice(X25519_KEY_BYTES, X25519_KEY_BYTES + XCHACHA_NONCE_BYTES);
  const ct = blob.slice(X25519_KEY_BYTES + XCHACHA_NONCE_BYTES);

  const buyerPub = x25519.getPublicKey(buyerX25519Priv);
  const shared = x25519.getSharedSecret(buyerX25519Priv, ephemeralPub);
  const key = deriveSymmetricKey(shared, ephemeralPub, buyerPub);
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ct);
}
