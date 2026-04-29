/**
 * PDA helpers Codama can't generate automatically.
 *
 * Codama only emits a PDA helper when every seed is derivable from
 * either accounts or constants. The Rfp PDA's `rfp_nonce` seed is
 * an instruction arg, so we hand-roll it here.
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
