/**
 * Wallet-derived deterministic ephemeral bid wallet.
 *
 * Used in Private Bidder List mode. Provider's main wallet signs a
 * deterministic message → HKDF → 32-byte seed → @solana/web3.js Keypair.
 * Same main wallet + same RFP = same ephemeral keypair, every time, on any
 * device. No localStorage backup burden.
 *
 * The cryptographic link (main → ephemeral) lives only in the user's wallet
 * signature history (locally), never on-chain. Public observers cannot
 * derive the ephemeral from the main without the main wallet's signature.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Keypair } from '@solana/web3.js';

const DOMAIN = 'tender-ephemeral-bid-wallet-v1';

/** The exact bytes the user signs. */
export function deriveEphemeralBidWalletMessage(rfpPda: string): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(
    [
      DOMAIN,
      `rfp=${rfpPda}`,
      'I am deriving an ephemeral bidder wallet for this RFP.',
      'Approve this signature to generate the keypair. No funds will move.',
    ].join('\n'),
  );
}

/**
 * Take a wallet ed25519 signature (64 bytes) over the seed message and
 * produce a deterministic Solana Keypair.
 */
export async function deriveEphemeralBidKeypair(walletSignature: Uint8Array): Promise<Keypair> {
  if (walletSignature.byteLength !== 64) {
    throw new Error(
      `deriveEphemeralBidKeypair: expected 64-byte signature, got ${walletSignature.byteLength}`,
    );
  }
  const salt = new TextEncoder().encode('tender-ephemeral-bid-wallet-v1-salt');
  const info = new TextEncoder().encode('solana-ed25519-seed');
  const seed = hkdf(sha256, walletSignature, salt, info, 32);
  const { Keypair } = await import('@solana/web3.js');
  return Keypair.fromSeed(seed);
}

/* -------------------------------------------------------------------------- */
/* Bid-binding signature - proves this main wallet owns the ephemeral bid.   */
/* Verified on-chain at select_bid time via Ed25519SigVerify.                 */
/* -------------------------------------------------------------------------- */

const BINDING_DOMAIN = 'tender-bid-binding-v1';
const PROGRAM_ID_FOR_BINDING = '4RSbGBZQ7CDSv78DG3VoMcaKXBsoYvh9ZofEo6mTCvfQ';

/**
 * The exact message the provider's main wallet signs to bind itself to a
 * specific bid PDA. Format must match the on-chain Tender program byte-for-byte
 * (see `programs/tender/src/instructions/select_bid.rs::build_binding_message`).
 */
export function buildBidBindingMessage(
  rfpPda: string,
  bidPda: string,
  mainWallet: string,
): Uint8Array {
  const lines = [
    BINDING_DOMAIN,
    `program=${PROGRAM_ID_FOR_BINDING}`,
    `rfp=${rfpPda}`,
    `bid=${bidPda}`,
    `main=${mainWallet}`,
  ];
  return new TextEncoder().encode(lines.join('\n'));
}
