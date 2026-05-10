import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { deriveProviderKeypair, deriveProviderSeedMessage } from '../derive-provider-keypair';
import {
  KEYCHAIN_DOMAIN,
  type KeychainRole,
  deriveBidderEphemeral,
  deriveBuyerEphemeral,
  deriveFundEphemeral,
  deriveKeychainSeedMessage,
  deriveMasterSeed,
  derivePayoutEphemeral,
  deriveRefundEphemeral,
  deriveSlotSeed,
} from '../keychain';

const dec = new TextDecoder();

function fakeSign(message: Uint8Array, secret: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret);
}

function newWallet(): Uint8Array {
  return ed25519.utils.randomSecretKey();
}

function masterFromWallet(wallet: Uint8Array): Uint8Array {
  return deriveMasterSeed(fakeSign(deriveKeychainSeedMessage(), wallet));
}

describe('deriveKeychainSeedMessage', () => {
  it('starts with the Tender app banner', () => {
    const text = dec.decode(deriveKeychainSeedMessage());
    expect(text).toMatch(/^Tender — unlock your private procurement keychain/);
  });

  it('includes the domain version + non-transaction warning + origin lock', () => {
    const text = dec.decode(deriveKeychainSeedMessage());
    expect(text).toContain(KEYCHAIN_DOMAIN);
    expect(text).toContain('NOT a transaction');
    expect(text).toContain('tendr.bid');
  });

  it('does not start with a byte that wallets misread as a tx prefix', () => {
    const msg = deriveKeychainSeedMessage();
    expect(msg[0]).toBe(0x54); // 'T'
    expect(msg.byteLength).toBeGreaterThan(64);
  });

  it('is byte-deterministic across calls', () => {
    expect(deriveKeychainSeedMessage()).toEqual(deriveKeychainSeedMessage());
  });
});

describe('deriveMasterSeed', () => {
  it('rejects signatures of wrong length', () => {
    expect(() => deriveMasterSeed(new Uint8Array(63))).toThrow(/64 bytes/);
    expect(() => deriveMasterSeed(new Uint8Array(65))).toThrow(/64 bytes/);
  });

  it('determinism: same wallet → identical master seed', () => {
    const w = newWallet();
    expect(masterFromWallet(w)).toEqual(masterFromWallet(w));
  });

  it('different wallets → different master seeds', () => {
    expect(masterFromWallet(newWallet())).not.toEqual(masterFromWallet(newWallet()));
  });

  it('produces 32 bytes', () => {
    expect(masterFromWallet(newWallet()).byteLength).toBe(32);
  });
});

describe('deriveSlotSeed', () => {
  const wallet = newWallet();
  const master = masterFromWallet(wallet);

  it('produces 32 bytes', () => {
    expect(deriveSlotSeed(master, 'buyer', '0').byteLength).toBe(32);
  });

  it('rejects master seeds of wrong length', () => {
    expect(() => deriveSlotSeed(new Uint8Array(31), 'buyer', '0')).toThrow(/32 bytes/);
  });

  it('determinism: same (master, role, suffix) → identical seed', () => {
    expect(deriveSlotSeed(master, 'buyer', '0')).toEqual(deriveSlotSeed(master, 'buyer', '0'));
  });

  it('changing the role changes the seed (domain separation)', () => {
    const roles: KeychainRole[] = ['buyer', 'bidder', 'fund', 'refund', 'payout'];
    const seeds = roles.map((r) => deriveSlotSeed(master, r, '0'));
    // No two roles produce the same seed for the same suffix.
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        expect(seeds[i]).not.toEqual(seeds[j]);
      }
    }
  });

  it('changing the suffix changes the seed (per-index separation)', () => {
    const s0 = deriveSlotSeed(master, 'buyer', '0');
    const s1 = deriveSlotSeed(master, 'buyer', '1');
    const s2 = deriveSlotSeed(master, 'buyer', '2');
    expect(s0).not.toEqual(s1);
    expect(s1).not.toEqual(s2);
    expect(s0).not.toEqual(s2);
  });

  it('changing the wallet changes the seed (per-wallet separation)', () => {
    const otherMaster = masterFromWallet(newWallet());
    expect(deriveSlotSeed(master, 'buyer', '0')).not.toEqual(
      deriveSlotSeed(otherMaster, 'buyer', '0'),
    );
  });
});

describe('per-role convenience wrappers', () => {
  it('all five roles produce distinct keypairs at the same index', async () => {
    const master = masterFromWallet(newWallet());
    const [buyer, bidder, fund, refund, payout] = await Promise.all([
      deriveBuyerEphemeral(master, 0),
      deriveBidderEphemeral(master, 0),
      deriveFundEphemeral(master, 'AnyRfpPda', 0),
      deriveRefundEphemeral(master, 0),
      derivePayoutEphemeral(master, 0),
    ]);
    const pubkeys = [buyer, bidder, fund, refund, payout].map((k) => k.publicKey.toBase58());
    expect(new Set(pubkeys).size).toBe(5); // all unique
  });

  it('deriveBuyerEphemeral is deterministic across calls', async () => {
    const master = masterFromWallet(newWallet());
    const a = await deriveBuyerEphemeral(master, 7);
    const b = await deriveBuyerEphemeral(master, 7);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
    expect(a.secretKey).toEqual(b.secretKey);
  });

  it('deriveFundEphemeral keys differ across (rfp, seq) combinations', async () => {
    const master = masterFromWallet(newWallet());
    const a = await deriveFundEphemeral(master, 'RfpA', 0);
    const b = await deriveFundEphemeral(master, 'RfpA', 1); // same rfp, next seq
    const c = await deriveFundEphemeral(master, 'RfpB', 0); // different rfp
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
    expect(a.publicKey.toBase58()).not.toBe(c.publicKey.toBase58());
    expect(b.publicKey.toBase58()).not.toBe(c.publicKey.toBase58());
  });

  it('different wallets → different ephemerals at the same index', async () => {
    const m1 = masterFromWallet(newWallet());
    const m2 = masterFromWallet(newWallet());
    const a = await deriveBidderEphemeral(m1, 5);
    const b = await deriveBidderEphemeral(m2, 5);
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });
});

describe('cross-module isolation', () => {
  // Sanity check: a wallet that's both v1 (per-role-only) and v2 (HD keychain)
  // doesn't accidentally produce the same key under both schemes. This pins
  // the domain separation between the legacy provider-X25519 derivation and
  // the new keychain bidder ephemeral.
  it('legacy provider X25519 key !== keychain bidder ephemeral seed', () => {
    const wallet = newWallet();
    const v1ProviderSig = fakeSign(deriveProviderSeedMessage(), wallet);
    const v1ProviderKp = deriveProviderKeypair(v1ProviderSig);
    const v2Master = masterFromWallet(wallet);
    const v2BidderSeed = deriveSlotSeed(v2Master, 'bidder', '0');
    expect(v1ProviderKp.x25519PrivateKey).not.toEqual(v2BidderSeed);
  });
});
