import { hkdf } from '@noble/hashes/hkdf.js';
/**
 * Wallet-derived deterministic Cloak UTXO keypair.
 *
 * Why: persistence in localStorage is fragile (browser cache clear = lost
 * funds). Wallet-derived keys recover automatically on any device the user's
 * Solana wallet is on, in exchange for a slight info-leak (the signed message
 * has the Tender domain prefix, so the user's signing history reveals "uses
 * Tender"). For our procurement use case that trade-off is favorable.
 *
 * The signature is HKDF-extracted to a 32-byte UTXO private key seed. Each
 * (RFP, bid_index) pair derives a distinct keypair so a wallet can have many
 * UTXOs over time without key reuse.
 */
import { sha256 } from '@noble/hashes/sha2.js';

const DOMAIN = 'tender-utxo-keypair-v1';

/** The exact bytes the user signs. */
export function deriveUtxoSeedMessage(rfpPda: string, bidIndex: number): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(
    [
      DOMAIN,
      `rfp=${rfpPda}`,
      `bid_index=${bidIndex}`,
      'I am deriving a one-time privacy keypair for a Tender bid.',
      'Approve this signature to generate the keypair. No funds will move.',
    ].join('\n'),
  );
}

/**
 * Take a wallet ed25519 signature (64 bytes) over `deriveUtxoSeedMessage(...)`,
 * HKDF-extract to a 32-byte UTXO private key. Determined by the signature
 * alone - no randomness - so the same wallet + same (rfp, index) always gets
 * the same keypair.
 */
export function deriveUtxoPrivateKey(walletSignature: Uint8Array): Uint8Array {
  if (walletSignature.byteLength !== 64) {
    throw new Error(
      `deriveUtxoPrivateKey: expected 64-byte signature, got ${walletSignature.byteLength}`,
    );
  }
  // HKDF(SHA-256, salt='tender-utxo-v1-salt', info='cloak-utxo-priv', ikm=signature, length=32)
  const salt = new TextEncoder().encode('tender-utxo-v1-salt');
  const info = new TextEncoder().encode('cloak-utxo-priv');
  return hkdf(sha256, walletSignature, salt, info, 32);
}
