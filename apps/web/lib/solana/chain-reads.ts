/**
 * Chain-reads — canonical helpers for reading authoritative state from the
 * on-chain Tender program. After the Day 6.5 supabase shrink (migration 0006),
 * `Rfp` and `BidCommit` accounts are the source of truth for windows, status,
 * bid_count, winner, identity, visibility, etc. Supabase only joins the
 * human-readable text fields by `on_chain_pda`.
 *
 * Use `getProgramAccounts` with memcmp filters for list queries — much faster
 * than fetching one-by-one and works at the RPC layer.
 */
import {
  type Address,
  type GetProgramAccountsMemcmpFilter,
  type ReadonlyUint8Array,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getBase58Decoder,
} from '@solana/kit';
import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-kit';
import { accounts } from '@tender/tender-client';

import { rpc, tenderProgramId } from './client';

const addressEncoder = getAddressEncoder();
const b64ToBytes = getBase64Encoder();
const bytesToB64 = getBase64Decoder();
const bytesToB58 = getBase58Decoder();

/* -------------------------------------------------------------------------- */
/* Decoders + discriminators                                                   */
/* -------------------------------------------------------------------------- */

const RFP_DISCRIMINATOR = accounts.RFP_DISCRIMINATOR;
const BID_COMMIT_DISCRIMINATOR = accounts.BID_COMMIT_DISCRIMINATOR;

function disc(bytes: ReadonlyUint8Array | Uint8Array): string {
  return bytesToB58.decode(new Uint8Array(bytes));
}

function memcmp(offset: number, bytes: ReadonlyUint8Array | Uint8Array): GetProgramAccountsMemcmpFilter {
  // Cast: kit brands base58/base64 strings as nominal types; runtime is plain string.
  return {
    // biome-ignore lint/suspicious/noExplicitAny: branded string nominal cast
    memcmp: { offset: BigInt(offset), bytes: disc(bytes) as any, encoding: 'base58' },
  };
}

/* -------------------------------------------------------------------------- */
/* Rfp                                                                         */
/* -------------------------------------------------------------------------- */

export type RfpChain = ReturnType<ReturnType<typeof accounts.getRfpDecoder>['decode']>;
export type BidCommitChain = ReturnType<ReturnType<typeof accounts.getBidCommitDecoder>['decode']>;

export interface RfpWithAddress {
  address: Address;
  data: RfpChain;
}

export interface BidCommitWithAddress {
  address: Address;
  data: BidCommitChain;
}

/** Read a single Rfp account by its PDA. */
export async function fetchRfp(pda: Address): Promise<RfpChain | null> {
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const bytes = new Uint8Array(b64ToBytes.encode(value.data[0]));
  return accounts.getRfpDecoder().decode(bytes);
}

export interface ListRfpsFilter {
  buyer?: Address;
}

/** List all Rfp accounts owned by Tender, optionally filtered by buyer. */
export async function listRfps(filter: ListRfpsFilter = {}): Promise<RfpWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [
    memcmp(0, RFP_DISCRIMINATOR),
  ];
  if (filter.buyer) {
    // Rfp layout: discriminator (0..8), buyer Pubkey (8..40), ...
    filters.push(memcmp(8, addressEncoder.encode(filter.buyer)));
  }

  const result = await rpc
    .getProgramAccounts(tenderProgramId, { encoding: 'base64', filters })
    .send();

  return result
    .map(({ pubkey, account }) => {
      // Each entry's data is [base64String, encoding].
      const dataField = account.data;
      const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
      const bytes = new Uint8Array(b64ToBytes.encode(b64));
      try {
        return { address: pubkey as Address, data: accounts.getRfpDecoder().decode(bytes) };
      } catch {
        return null;
      }
    })
    .filter((r): r is RfpWithAddress => r != null);
}

/* -------------------------------------------------------------------------- */
/* BidCommit                                                                   */
/* -------------------------------------------------------------------------- */

/** Read a single BidCommit account by its PDA. Falls through to ER if base layer
 *  doesn't have current state (e.g. account is delegated).
 *  Caller decides which RPC to use by passing it explicitly when needed. */
export async function fetchBidCommit(pda: Address): Promise<BidCommitChain | null> {
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const bytes = new Uint8Array(b64ToBytes.encode(value.data[0]));
  return accounts.getBidCommitDecoder().decode(bytes);
}

export interface ListBidsFilter {
  /** Filter to bids on a specific RFP. */
  rfpPda?: Address;
  /** Filter to L0 bids placed by a specific provider wallet. */
  providerWallet?: Address;
  /** Filter to L1 bids placed by a wallet whose sha256 matches. */
  providerWalletHash?: ReadonlyUint8Array | Uint8Array;
}

/**
 * List BidCommit accounts, optionally filtered by RFP and/or provider identity.
 *
 * **Important:** queries TWO program-owners and merges. When a bid is delegated
 * to MagicBlock PER (its lifetime state until withdraw or select), the account's
 * owner is `DELEGATION_PROGRAM_ID`, not our Tender program. The data layout
 * (BidCommit struct + 8-byte discriminator at offset 0) is preserved across
 * delegation, so the same memcmp filters work for both queries.
 *
 * - `getProgramAccounts(TENDER_PROGRAM_ID)` returns undelegated bids (post
 *   withdraw/select).
 * - `getProgramAccounts(DELEGATION_PROGRAM_ID)` returns currently-delegated
 *   bids (active in PER). The discriminator filter narrows away other
 *   delegated accounts in the global delegation program.
 *
 * BidCommit layout offsets (preserved through delegation):
 *   0..8   discriminator
 *   8..40  rfp Pubkey
 *   40..72 buyer Pubkey
 *   72..80 bid_close_at i64
 *   80..112 bid_pda_seed [u8;32]
 *   112    provider_identity tag (0=Plain, 1=Hashed)
 *   113..145 provider_identity payload [u8;32]
 *   ...
 */
export async function listBids(filter: ListBidsFilter = {}): Promise<BidCommitWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [
    memcmp(0, BID_COMMIT_DISCRIMINATOR),
  ];
  if (filter.rfpPda) {
    filters.push(memcmp(8, addressEncoder.encode(filter.rfpPda)));
  }
  if (filter.providerWallet) {
    // Plain identity: tag = 0 at offset 112, then 32-byte pubkey at 113.
    filters.push(memcmp(112, new Uint8Array([0])));
    filters.push(memcmp(113, addressEncoder.encode(filter.providerWallet)));
  }
  if (filter.providerWalletHash) {
    // Hashed identity: tag = 1 at offset 112, then 32-byte sha256 at 113.
    filters.push(memcmp(112, new Uint8Array([1])));
    filters.push(memcmp(113, filter.providerWalletHash));
  }

  // Hit both program owners in parallel and dedup by address.
  const [undelegated, delegated] = await Promise.all([
    rpc.getProgramAccounts(tenderProgramId, { encoding: 'base64', filters }).send(),
    rpc.getProgramAccounts(DELEGATION_PROGRAM_ID, { encoding: 'base64', filters }).send(),
  ]);

  const out = new Map<string, BidCommitWithAddress>();
  for (const { pubkey, account } of [...undelegated, ...delegated]) {
    if (out.has(pubkey)) continue;
    const dataField = account.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    const bytes = new Uint8Array(b64ToBytes.encode(b64));
    try {
      out.set(pubkey, {
        address: pubkey as Address,
        data: accounts.getBidCommitDecoder().decode(bytes),
      });
    } catch {
      // Skip accounts whose data doesn't deserialize (different account type
      // owned by the same program — shouldn't happen with discriminator filter
      // in place but defensive).
    }
  }
  return Array.from(out.values());
}

/* -------------------------------------------------------------------------- */
/* Convenience formatters — translate on-chain types into UI-friendly shapes. */
/* -------------------------------------------------------------------------- */

/** Convert an on-chain bigint unix-second timestamp to an ISO string. */
export function unixSecondsToIso(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

/** Convert a u64 micro-USDC amount to a decimal string ("45000.50"). */
export function microUsdcToDecimal(micro: bigint): string {
  const usdc = Number(micro) / 1_000_000;
  return usdc.toString();
}

/** Maps RfpStatus enum (codama) to its on-chain string. */
export function rfpStatusToString(status: RfpChain['status']): string {
  // Codama generates discriminant unions for Anchor enums.
  // status is a number whose value mirrors RfpStatus enum order.
  const names = [
    'draft',
    'open',
    'reveal',
    'awarded',
    'in_progress',
    'completed',
    'disputed',
    'cancelled',
  ];
  return names[status as unknown as number] ?? 'unknown';
}

export function bidderVisibilityToString(v: RfpChain['bidderVisibility']): 'public' | 'buyer_only' {
  return (v as unknown as number) === 0 ? 'public' : 'buyer_only';
}

/** Hex-encode a byte array (for commit_hash display and the like). */
export function bytesToHex(bytes: ReadonlyUint8Array | Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

void bytesToB64; // tree-shake guard — exported for callers that need the inverse later
