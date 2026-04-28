import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { RFP_NONCE_BYTES, deriveRfpKeypair, deriveSeedMessage } from '../derive-rfp-keypair';
import { decryptBid, encryptBid } from '../ecies';

const enc = new TextEncoder();
const dec = new TextDecoder();

function fakeWalletSign(message: Uint8Array, walletSecret: Uint8Array): Uint8Array {
  // Real ed25519 signing — same algorithm Phantom/Backpack use under the hood.
  // No mock; exercises the actual cryptography path the wallet would.
  return ed25519.sign(message, walletSecret);
}

function newWalletSecret(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

function nonce(value: number): Uint8Array {
  const b = new Uint8Array(RFP_NONCE_BYTES);
  new DataView(b.buffer).setBigUint64(0, BigInt(value));
  return b;
}

describe('deriveSeedMessage', () => {
  it('rejects nonces of wrong length', () => {
    expect(() => deriveSeedMessage(new Uint8Array(7))).toThrow(/rfp_nonce/);
    expect(() => deriveSeedMessage(new Uint8Array(9))).toThrow(/rfp_nonce/);
  });

  it('produces a human-readable message containing the domain banner and nonce hex', () => {
    const msg = deriveSeedMessage(nonce(0x1234));
    const text = dec.decode(msg);
    expect(text).toMatch(/^Tender — derive sealed-bid encryption keypair \(tender-rfp-key-v1\)/);
    expect(text).toContain('This is NOT a transaction');
    expect(text).toContain('RFP nonce: 0x0000000000001234');
  });

  it('is byte-deterministic for the same nonce', () => {
    const a = deriveSeedMessage(nonce(7));
    const b = deriveSeedMessage(nonce(7));
    expect(a).toEqual(b);
  });

  it('does not start with a byte that wallets misread as a transaction prefix', () => {
    // Phantom and others reject signMessage when the bytes look transaction-shaped.
    // Our message should start with ASCII 'T' (0x54) — not 0x80 (versioned tx flag),
    // and should be far longer than a single short tx, so the heuristic clears it.
    const msg = deriveSeedMessage(nonce(0));
    expect(msg[0]).toBe(0x54);
    expect(msg.byteLength).toBeGreaterThan(64);
  });
});

describe('deriveRfpKeypair', () => {
  it('rejects signatures of wrong length', () => {
    expect(() => deriveRfpKeypair(new Uint8Array(63))).toThrow(/64 bytes/);
    expect(() => deriveRfpKeypair(new Uint8Array(65))).toThrow(/64 bytes/);
  });

  it('determinism: same wallet + same nonce → identical keypair', () => {
    const wallet = newWalletSecret();
    const message = deriveSeedMessage(nonce(42));
    const sig1 = fakeWalletSign(message, wallet);
    const sig2 = fakeWalletSign(message, wallet);
    // ed25519 is deterministic by RFC 8032
    expect(sig1).toEqual(sig2);

    const kp1 = deriveRfpKeypair(sig1);
    const kp2 = deriveRfpKeypair(sig2);
    expect(kp1.x25519PrivateKey).toEqual(kp2.x25519PrivateKey);
    expect(kp1.x25519PublicKey).toEqual(kp2.x25519PublicKey);
  });

  it('different nonces → different keypairs (same wallet)', () => {
    const wallet = newWalletSecret();
    const sigA = fakeWalletSign(deriveSeedMessage(nonce(1)), wallet);
    const sigB = fakeWalletSign(deriveSeedMessage(nonce(2)), wallet);
    const kpA = deriveRfpKeypair(sigA);
    const kpB = deriveRfpKeypair(sigB);
    expect(kpA.x25519PublicKey).not.toEqual(kpB.x25519PublicKey);
  });

  it('different wallets → different keypairs (same nonce)', () => {
    const w1 = newWalletSecret();
    const w2 = newWalletSecret();
    const message = deriveSeedMessage(nonce(99));
    const kp1 = deriveRfpKeypair(fakeWalletSign(message, w1));
    const kp2 = deriveRfpKeypair(fakeWalletSign(message, w2));
    expect(kp1.x25519PublicKey).not.toEqual(kp2.x25519PublicKey);
  });

  it('end-to-end: derived keypair encrypts + decrypts a sample bid', () => {
    const wallet = newWalletSecret();
    const rfpNonce = nonce(0xdeadbeef);
    const message = deriveSeedMessage(rfpNonce);
    const sig = fakeWalletSign(message, wallet);
    const buyerKp = deriveRfpKeypair(sig);

    const plaintext = enc.encode(JSON.stringify({ priceUsdc: '45000', timeline: '6w' }));
    const sealed = encryptBid(plaintext, buyerKp.x25519PublicKey);
    const recovered = decryptBid(sealed.blob, buyerKp.x25519PrivateKey);

    expect(dec.decode(recovered)).toBe(dec.decode(plaintext));
  });
});
