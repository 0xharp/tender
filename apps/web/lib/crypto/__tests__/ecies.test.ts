import { x25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { commitHash, commitHashHex } from '../commit';
import {
  X25519_KEY_BYTES,
  XCHACHA_NONCE_BYTES,
  decryptBid,
  encryptBid,
  generateEphemeralKeypair,
} from '../ecies';

const enc = new TextEncoder();
const dec = new TextDecoder();

function freshBuyerKeypair() {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}

describe('ECIES round-trip', () => {
  it('encrypt then decrypt recovers the exact plaintext', () => {
    const buyer = freshBuyerKeypair();
    const plaintext = enc.encode(
      JSON.stringify({
        priceUsdc: '45000',
        scope: 'Smart contract audit, 6 weeks',
        timelineDays: 42,
      }),
    );

    const sealed = encryptBid(plaintext, buyer.pub);
    const recovered = decryptBid(sealed.blob, buyer.priv);

    expect(dec.decode(recovered)).toBe(dec.decode(plaintext));
  });

  it('blob layout: ephemeralPub (32) || nonce (24) || ciphertext+tag', () => {
    const buyer = freshBuyerKeypair();
    const plaintext = enc.encode('hi');
    const sealed = encryptBid(plaintext, buyer.pub);

    expect(sealed.ephemeralPub.byteLength).toBe(X25519_KEY_BYTES);
    expect(sealed.commitHash.byteLength).toBe(32);
    // header (32 + 24) + plaintext (2) + Poly1305 tag (16) = 74
    expect(sealed.blob.byteLength).toBe(X25519_KEY_BYTES + XCHACHA_NONCE_BYTES + 2 + 16);
    expect(sealed.blob.slice(0, X25519_KEY_BYTES)).toEqual(sealed.ephemeralPub);
  });

  it('commitHash equals sha256(blob)', () => {
    const buyer = freshBuyerKeypair();
    const sealed = encryptBid(enc.encode('test'), buyer.pub);
    expect(commitHash(sealed.blob)).toEqual(sealed.commitHash);
  });

  it('different ephemeral keys → different ciphertexts for same plaintext', () => {
    const buyer = freshBuyerKeypair();
    const plaintext = enc.encode('identical bid');
    const a = encryptBid(plaintext, buyer.pub);
    const b = encryptBid(plaintext, buyer.pub);

    expect(a.blob).not.toEqual(b.blob);
    expect(a.commitHash).not.toEqual(b.commitHash);
    // But both decrypt to same plaintext
    expect(decryptBid(a.blob, buyer.priv)).toEqual(decryptBid(b.blob, buyer.priv));
  });

  it('determinism: fixed ephemeralPriv + nonce → byte-identical blob', () => {
    const buyer = freshBuyerKeypair();
    const plaintext = enc.encode('deterministic');
    const ephemeralPriv = x25519.utils.randomSecretKey();
    const nonce = randomBytes(XCHACHA_NONCE_BYTES);

    const a = encryptBid(plaintext, buyer.pub, { ephemeralPriv, nonce });
    const b = encryptBid(plaintext, buyer.pub, { ephemeralPriv, nonce });

    expect(a.blob).toEqual(b.blob);
    expect(a.commitHash).toEqual(b.commitHash);
  });

  it('two providers cannot decrypt each other (forward secrecy per bid)', () => {
    const buyer = freshBuyerKeypair();
    const provider1 = generateEphemeralKeypair();
    const provider2 = generateEphemeralKeypair();

    const bid1 = encryptBid(enc.encode('provider 1 bid'), buyer.pub, {
      ephemeralPriv: provider1.priv,
    });
    const bid2 = encryptBid(enc.encode('provider 2 bid'), buyer.pub, {
      ephemeralPriv: provider2.priv,
    });

    // Buyer can decrypt both
    expect(dec.decode(decryptBid(bid1.blob, buyer.priv))).toBe('provider 1 bid');
    expect(dec.decode(decryptBid(bid2.blob, buyer.priv))).toBe('provider 2 bid');
  });

  it('wrong buyer private key cannot decrypt - Poly1305 tag verification fails', () => {
    const buyer = freshBuyerKeypair();
    const attacker = freshBuyerKeypair();
    const sealed = encryptBid(enc.encode('secret bid'), buyer.pub);

    expect(() => decryptBid(sealed.blob, attacker.priv)).toThrow();
  });

  it('tampered ciphertext fails AEAD verification', () => {
    const buyer = freshBuyerKeypair();
    const sealed = encryptBid(enc.encode('original'), buyer.pub);

    // flip a bit deep in the ciphertext (past the header)
    const tampered = new Uint8Array(sealed.blob);
    const idx = X25519_KEY_BYTES + XCHACHA_NONCE_BYTES + 1;
    tampered[idx] = (tampered[idx]! ^ 0x01) & 0xff;

    expect(() => decryptBid(tampered, buyer.priv)).toThrow();
  });

  it('tampered ciphertext also produces a different commit hash (independent integrity)', () => {
    const buyer = freshBuyerKeypair();
    const sealed = encryptBid(enc.encode('original'), buyer.pub);
    const tampered = new Uint8Array(sealed.blob);
    tampered[60] = (tampered[60]! ^ 0xff) & 0xff;
    expect(commitHashHex(tampered)).not.toBe(commitHashHex(sealed.blob));
  });

  it('rejects nonce of wrong length', () => {
    const buyer = freshBuyerKeypair();
    const badNonce = new Uint8Array(20); // not 24
    expect(() => encryptBid(enc.encode('x'), buyer.pub, { nonce: badNonce })).toThrow(
      /nonce must be/,
    );
  });

  it('rejects buyer pubkey of wrong length', () => {
    const badPub = new Uint8Array(31);
    expect(() => encryptBid(enc.encode('x'), badPub)).toThrow(/X25519 pubkey/);
  });

  it('rejects buyer priv of wrong length on decrypt', () => {
    const buyer = freshBuyerKeypair();
    const sealed = encryptBid(enc.encode('x'), buyer.pub);
    const badPriv = new Uint8Array(31);
    expect(() => decryptBid(sealed.blob, badPriv)).toThrow(/X25519 priv/);
  });

  it('rejects blob too short to contain header + tag', () => {
    const buyer = freshBuyerKeypair();
    const tooShort = new Uint8Array(40);
    expect(() => decryptBid(tooShort, buyer.priv)).toThrow(/blob too short/);
  });
});

describe('commit', () => {
  it('commitHash is deterministic', () => {
    const blob = enc.encode('some ciphertext');
    expect(commitHash(blob)).toEqual(commitHash(blob));
    expect(commitHashHex(blob)).toBe(commitHashHex(blob));
  });

  it('commitHashHex is 64 lowercase hex chars', () => {
    const hex = commitHashHex(enc.encode('x'));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
