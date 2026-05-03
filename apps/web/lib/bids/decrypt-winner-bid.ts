/**
 * Decrypt the winning bid plaintext for a given RFP, from EITHER the buyer
 * envelope (buyer caller) or the provider envelope (winning provider caller).
 *
 * Used by the milestone-management surfaces (buyer + provider action panels)
 * to surface per-milestone success criteria + descriptions inline. The
 * plaintext is the same regardless of which envelope you decrypt; we pick the
 * one the caller has the X25519 key for.
 *
 * The provider-side variant is special in private-mode RFPs: the provider's
 * X25519 key is derived from a per-RFP ephemeral wallet (not the main wallet),
 * so the caller must supply the ephemeral signMessage closure. In public mode
 * the bid signer == main wallet and the caller's regular signMessage works.
 *
 * Errors return as `null` (no plaintext) so the UI can fall back gracefully
 * without throwing - the milestone-management flow shouldn't break if the
 * decrypt path has an issue.
 */
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { accounts } from '@tender/tender-client';

import { type SealedBidPlaintext, sealedBidPlaintextSchema } from '@/lib/bids/schema';
import {
  type DerivedRfpKeypair,
  deriveRfpKeypair,
  deriveSeedMessage,
} from '@/lib/crypto/derive-rfp-keypair';
import { decryptBid } from '@/lib/crypto/ecies';
import {
  ensureTeeAuthToken,
  ephemeralRpc,
  fetchDelegatedAccountBytes,
} from '@/lib/sdks/magicblock';

export type DecryptStage =
  | 'deriving_key'
  | 'authenticating_er'
  | 'fetching_bid'
  | 'decrypting'
  | 'done';

export interface DecryptWinnerBidAsBuyerInput {
  /** The buyer's main wallet (the one that created the RFP). */
  buyerWallet: Address;
  /** The on-chain BidCommit PDA of the WINNING bid (`rfp.winner`). */
  winnerBidPda: Address;
  /** Off-chain rfp_nonce_hex - drives the buyer's per-RFP X25519 derivation. */
  rfpNonceHex: string;
  signMessage: (input: { message: Uint8Array }) => Promise<{ signature: Uint8Array }>;
  /** Cached buyer keypair from a previous decrypt - skips the wallet popup. */
  cachedBuyerKp?: DerivedRfpKeypair;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (stage: DecryptStage) => void;
}

export interface DecryptedWinnerBid {
  plaintext: SealedBidPlaintext;
  /** Cached so the caller can persist for subsequent re-decrypts (e.g. on
   *  refresh) without another wallet popup. */
  buyerKp?: DerivedRfpKeypair;
}

/**
 * Buyer-role decrypt. Reads the BUYER envelope from the on-chain BidCommit
 * (already past `open_reveal_window` since the RFP is post-award), decrypts
 * with the buyer's per-RFP X25519 key.
 */
export async function decryptWinnerBidAsBuyer(
  input: DecryptWinnerBidAsBuyerInput,
): Promise<DecryptedWinnerBid | null> {
  const { buyerWallet, winnerBidPda, rfpNonceHex, signMessage, rpc, onProgress } = input;

  // 1. Buyer X25519 keypair (cached or fresh).
  let buyerKp = input.cachedBuyerKp;
  if (!buyerKp) {
    onProgress?.('deriving_key');
    const seedMsg = deriveSeedMessage(hexToBytes(rfpNonceHex));
    const { signature } = await signMessage({ message: seedMsg });
    buyerKp = deriveRfpKeypair(signature);
  }

  // 2. TEE auth + ER RPC. Bid is post-award so it's still delegated to PER
  //    until select_bid undelegates it - we read from the ER side defensively.
  //    If the bid has already been undelegated, fetchDelegatedAccountBytes
  //    falls through to the base layer.
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(buyerWallet, async (msg) => {
    const { signature } = await signMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  // 3. Fetch + decode the BidCommit. Try ER first (delegated bids), then base
  //    layer (post-undelegation winning bids).
  onProgress?.('fetching_bid');
  let bytes = await fetchDelegatedAccountBytes(winnerBidPda, erRpc).catch(() => null);
  if (!bytes) {
    const { value } = await rpc.getAccountInfo(winnerBidPda, { encoding: 'base64' }).send();
    if (!value) return null;
    const dataField = value.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    bytes = base64ToBytes(b64);
  }

  // 4. Decrypt the buyer envelope and parse.
  onProgress?.('decrypting');
  try {
    const decoded = accounts.getBidCommitDecoder().decode(bytes);
    const buyerEnvelope = decoded.buyerEnvelope as Uint8Array;
    const json = new TextDecoder().decode(decryptBid(buyerEnvelope, buyerKp.x25519PrivateKey));
    const parsed = sealedBidPlaintextSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    onProgress?.('done');
    return { plaintext: parsed.data, buyerKp };
  } catch {
    return null;
  }
}

export interface DecryptWinnerBidAsProviderInput {
  /** The wallet that signed the bid on-chain (`bid.provider`). In public mode
   *  this equals the provider's main wallet; in private mode it's the per-RFP
   *  ephemeral signer. */
  bidSignerWallet: Address;
  /** The on-chain BidCommit PDA of the WINNING bid. */
  winnerBidPda: Address;
  /** signMessage scoped to the bid signer (ephemeral keypair in private mode,
   *  main wallet in public mode). The caller is responsible for picking the
   *  right closure - this function just runs it. */
  bidSignerSignMessage: (input: {
    message: Uint8Array;
  }) => Promise<{ signature: Uint8Array }>;
  /** Cached provider keypair (X25519) - skip the wallet popup if present. */
  cachedProviderKp?: DerivedRfpKeypair;
  rpc: Rpc<SolanaRpcApi>;
  onProgress?: (stage: DecryptStage) => void;
}

export interface DecryptedWinnerBidAsProvider {
  plaintext: SealedBidPlaintext;
  providerKp?: DerivedRfpKeypair;
}

/**
 * Provider-role decrypt. Reads the PROVIDER envelope (encrypted to the
 * provider's bid-signer X25519 pubkey at submit time). Same plaintext as the
 * buyer envelope - either side gets the same data, just decrypted with their
 * own key.
 */
export async function decryptWinnerBidAsProvider(
  input: DecryptWinnerBidAsProviderInput,
): Promise<DecryptedWinnerBidAsProvider | null> {
  const { bidSignerWallet, winnerBidPda, bidSignerSignMessage, rpc, onProgress } = input;
  const { deriveProviderSeedMessage, deriveProviderKeypair } = await import(
    '@/lib/crypto/derive-provider-keypair'
  );

  // 1. Provider X25519 keypair (cached or fresh). Mirrors submit-flow: the
  //    derive-key signature is over `deriveProviderSeedMessage()` from the
  //    bid signer, NOT the main wallet.
  let providerKp = input.cachedProviderKp;
  if (!providerKp) {
    onProgress?.('deriving_key');
    const seedMsg = deriveProviderSeedMessage();
    const { signature } = await bidSignerSignMessage({ message: seedMsg });
    providerKp = deriveProviderKeypair(signature);
  }

  // 2. TEE auth scoped to the bid signer (PER permission gate is keyed to the
  //    bid signer wallet, not main).
  onProgress?.('authenticating_er');
  const teeToken = await ensureTeeAuthToken(bidSignerWallet, async (msg) => {
    const { signature } = await bidSignerSignMessage({ message: msg });
    return signature;
  });
  const erRpc = ephemeralRpc(teeToken);

  // 3. Fetch from ER, fall back to base layer.
  onProgress?.('fetching_bid');
  let bytes = await fetchDelegatedAccountBytes(winnerBidPda, erRpc).catch(() => null);
  if (!bytes) {
    const { value } = await rpc.getAccountInfo(winnerBidPda, { encoding: 'base64' }).send();
    if (!value) return null;
    const dataField = value.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    bytes = base64ToBytes(b64);
  }

  // 4. Decrypt the provider envelope and parse.
  onProgress?.('decrypting');
  try {
    const decoded = accounts.getBidCommitDecoder().decode(bytes);
    const providerEnvelope = decoded.providerEnvelope as Uint8Array;
    const json = new TextDecoder().decode(
      decryptBid(providerEnvelope, providerKp.x25519PrivateKey),
    );
    const parsed = sealedBidPlaintextSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return null;
    onProgress?.('done');
    return { plaintext: parsed.data, providerKp };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
