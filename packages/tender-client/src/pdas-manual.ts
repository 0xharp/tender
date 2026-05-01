/**
 * PDA helpers Codama can't generate automatically.
 *
 * Codama only emits a PDA helper when every seed is derivable from
 * either accounts or constants. PDAs whose seeds include instruction
 * args (rfp_nonce, bid_pda_seed) are hand-rolled here.
 */
import {
  type Address,
  type ProgramDerivedAddress,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';

import { TENDER_PROGRAM_ADDRESS } from './generated/programs/tender';

const addressEncoder = getAddressEncoder();
const RFP_SEED = new Uint8Array([114, 102, 112]); // "rfp"
const BID_SEED = new Uint8Array([98, 105, 100]); // "bid"

export interface FindRfpPdaInput {
  buyer: Address;
  rfpNonce: Uint8Array;
}

export async function findRfpPda({
  buyer,
  rfpNonce,
}: FindRfpPdaInput): Promise<ProgramDerivedAddress> {
  if (rfpNonce.byteLength !== 8) {
    throw new Error(`rfp_nonce must be 8 bytes, got ${rfpNonce.byteLength}`);
  }
  return getProgramDerivedAddress({
    programAddress: TENDER_PROGRAM_ADDRESS,
    seeds: [RFP_SEED, addressEncoder.encode(buyer), rfpNonce],
  });
}

export interface FindBidPdaInput {
  rfp: Address;
  /**
   * 32-byte PDA seed.
   * - L0 (Public): caller passes the provider's wallet bytes.
   * - L1 (BuyerOnly): caller passes a deterministic seed derived from
   *   `sha256(walletSig("tender-bid-seed-v1" || rfp_nonce))` so the seed
   *   is opaque to outside observers but re-derivable by the provider.
   */
  bidPdaSeed: Uint8Array;
}

export async function findBidPda({
  rfp,
  bidPdaSeed,
}: FindBidPdaInput): Promise<ProgramDerivedAddress> {
  if (bidPdaSeed.byteLength !== 32) {
    throw new Error(`bid_pda_seed must be 32 bytes, got ${bidPdaSeed.byteLength}`);
  }
  return getProgramDerivedAddress({
    programAddress: TENDER_PROGRAM_ADDRESS,
    seeds: [BID_SEED, addressEncoder.encode(rfp), bidPdaSeed],
  });
}
