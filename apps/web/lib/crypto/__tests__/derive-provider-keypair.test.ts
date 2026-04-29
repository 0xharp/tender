import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { deriveProviderKeypair, deriveProviderSeedMessage } from '../derive-provider-keypair';
import { deriveRfpKeypair, deriveSeedMessage } from '../derive-rfp-keypair';
import { decryptBid, encryptBid } from '../ecies';

const enc = new TextEncoder();
const dec = new TextDecoder();

function fakeSign(message: Uint8Array, secret: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret);
}

function newWallet(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

function nonce(value: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(value));
  return b;
}

describe('deriveProviderSeedMessage', () => {
  it('is human-readable and starts with the app banner', () => {
    const msg = deriveProviderSeedMessage();
    const text = dec.decode(msg);
    expect(text).toMatch(/^Tender — derive provider bid-decryption keypair/);
    expect(text).toContain('This is NOT a transaction');
  });

  it('does not start with a byte that wallets misread as a transaction prefix', () => {
    const msg = deriveProviderSeedMessage();
    expect(msg[0]).toBe(0x54); // 'T'
    expect(msg.byteLength).toBeGreaterThan(64);
  });

  it('is byte-deterministic across calls', () => {
    expect(deriveProviderSeedMessage()).toEqual(deriveProviderSeedMessage());
  });
});

describe('deriveProviderKeypair', () => {
  it('rejects signatures of wrong length', () => {
    expect(() => deriveProviderKeypair(new Uint8Array(63))).toThrow(/64 bytes/);
    expect(() => deriveProviderKeypair(new Uint8Array(65))).toThrow(/64 bytes/);
  });

  it('determinism: same wallet → identical keypair', () => {
    const wallet = newWallet();
    const message = deriveProviderSeedMessage();
    const sig = fakeSign(message, wallet);
    const kp1 = deriveProviderKeypair(sig);
    const kp2 = deriveProviderKeypair(fakeSign(message, wallet));
    expect(kp1.x25519PrivateKey).toEqual(kp2.x25519PrivateKey);
    expect(kp1.x25519PublicKey).toEqual(kp2.x25519PublicKey);
  });

  it('different wallets → different keypairs', () => {
    const w1 = newWallet();
    const w2 = newWallet();
    const message = deriveProviderSeedMessage();
    const kp1 = deriveProviderKeypair(fakeSign(message, w1));
    const kp2 = deriveProviderKeypair(fakeSign(message, w2));
    expect(kp1.x25519PublicKey).not.toEqual(kp2.x25519PublicKey);
  });

  it('domain-separated from buyer keypair (same wallet, different roles)', () => {
    const wallet = newWallet();
    const buyerSig = fakeSign(deriveSeedMessage(nonce(0xdead)), wallet);
    const providerSig = fakeSign(deriveProviderSeedMessage(), wallet);
    const buyerKp = deriveRfpKeypair(buyerSig);
    const providerKp = deriveProviderKeypair(providerSig);
    expect(buyerKp.x25519PublicKey).not.toEqual(providerKp.x25519PublicKey);
  });

  it('end-to-end: provider keypair encrypts + decrypts a sample bid back', () => {
    const wallet = newWallet();
    const sig = fakeSign(deriveProviderSeedMessage(), wallet);
    const kp = deriveProviderKeypair(sig);

    const plaintext = enc.encode(JSON.stringify({ priceUsdc: '45000', timeline: '6w' }));
    const sealed = encryptBid(plaintext, kp.x25519PublicKey);
    const recovered = decryptBid(sealed.blob, kp.x25519PrivateKey);
    expect(dec.decode(recovered)).toBe(dec.decode(plaintext));
  });
});
