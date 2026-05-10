import { DELEGATION_PROGRAM_ID } from '@magicblock-labs/ephemeral-rollups-kit';
/**
 * Chain-reads - canonical helpers for reading authoritative state from the
 * on-chain Tender program. After the Day 6.5 supabase shrink (migration 0006),
 * `Rfp` and `BidCommit` accounts are the source of truth for windows, status,
 * bid_count, winner, identity, visibility, etc. Supabase only joins the
 * human-readable text fields by `on_chain_pda`.
 *
 * Use `getProgramAccounts` with memcmp filters for list queries - much faster
 * than fetching one-by-one and works at the RPC layer.
 */
import {
  type Address,
  type GetProgramAccountsMemcmpFilter,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getUtf8Encoder,
} from '@solana/kit';
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

function memcmp(
  offset: number,
  bytes: ReadonlyUint8Array | Uint8Array,
): GetProgramAccountsMemcmpFilter {
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
  /** Filter to RFPs whose `winner_provider` matches this pubkey.
   *
   *  v2 semantics: `winner_provider` IS NOT always a main wallet. It mirrors
   *  `bid.provider` of the winning bid:
   *    - public bidder mode → main wallet (bid signed by main directly)
   *    - private bidder mode → per-RFP bidder ephemeral (bid signed by eph;
   *      select_bid sets `winner_provider = bid.provider` = eph)
   *
   *  Practical implications:
   *    - Passing a main wallet enumerates ONLY public-mode wins. Private-mode
   *      wins of the same provider are NOT returned (their winner_provider
   *      is the eph). Provider can later run `attest_win` to merge eph
   *      reputation counters into the main wallet's rep PDA, but
   *      `rfp.winner_provider` is never rewritten.
   *    - Passing an eph pubkey returns the one private-bidder RFP it won. */
  winnerProvider?: Address;
}

/** Rfp account byte layout for memcmp filters. Tracks the order of fields in
 *  `programs/tender/src/state/rfp.rs::Rfp`. Anchor lays out fixed-size fields
 *  contiguously; Option<T> is `1 + sizeof(T)` (tag byte + payload). Update
 *  these offsets if the on-chain struct changes shape (and update the lite-svm
 *  tests that exercise getProgramAccounts). */
const RFP_OFFSET_BUYER = 8; // 0..8 disc, then 32 bytes
const RFP_OFFSET_WINNER_PROVIDER = 167; // disc(8) + buyer(32) + buyer_enc(32)
//   + title_hash(32) + category(1) + bid_open_at(8) + bid_close_at(8)
//   + reveal_close_at(8) + milestone_count(1) + bidder_visibility(1)
//   + buyer_visibility(1) + buyer_attested(1) + status(1)
//   + winner Option<Pubkey>(33) = 167
//
// v2: bumped from 165 → 167 when buyer_visibility + buyer_attested
// were inserted between bidder_visibility and status. If the Rfp
// struct ever shifts again, recompute by walking the field list in
// `programs/tender/src/state/rfp.rs::Rfp`.

/** List all Rfp accounts owned by Tender, optionally filtered by buyer or
 *  by the main wallet that won the RFP. */
export async function listRfps(filter: ListRfpsFilter = {}): Promise<RfpWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [memcmp(0, RFP_DISCRIMINATOR)];
  if (filter.buyer) {
    filters.push(memcmp(RFP_OFFSET_BUYER, addressEncoder.encode(filter.buyer)));
  }
  if (filter.winnerProvider) {
    // winner_provider is Option<Pubkey>: 1-byte tag + 32-byte address. Match
    // both the Some-tag (0x01) and the address bytes so we don't false-match
    // None entries whose trailing bytes happen to coincide.
    const tagAndAddr = new Uint8Array(33);
    tagAndAddr[0] = 1;
    tagAndAddr.set(addressEncoder.encode(filter.winnerProvider), 1);
    filters.push(memcmp(RFP_OFFSET_WINNER_PROVIDER, tagAndAddr));
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
      } catch (e) {
        // Decode mismatch usually means the account was created against an
        // older program deploy with a smaller Rfp struct. We silently drop
        // it from the list (so the marketplace doesn't break). Logged at
        // `debug` so it stays out of the default dev console (noisy: same
        // ~6 stale accounts re-decoded on every page render); enable via
        // Node `--inspect` or by setting NODE_OPTIONS to surface it when
        // genuinely diagnosing "where did my RFP go".
        console.debug(
          `[listRfps] decoder failed for ${pubkey} (${bytes.length} bytes) - likely stale on-chain layout. ${(e as Error).message}`,
        );
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

/**
 * Batched read for many BidCommit PDAs in a single `getMultipleAccounts`
 * call. Returns a Map keyed on the address string for O(1) lookup. Missing
 * accounts (deleted, never created, wrong PDA) are simply absent from the
 * map — caller treats `.get(pda)` returning undefined as "not found".
 *
 * Use this when you have a list of bid PDAs known up-front (e.g. winning
 * bids of a set of RFPs you've already enumerated) — avoids N separate
 * `fetchBidCommit` round-trips. Solana RPC accepts up to 100 accounts per
 * batch, and a typical leaderboard's "private RFPs with a winner" list
 * sits well under that.
 */
export async function fetchBidCommitsBatched(
  pdas: Address[],
): Promise<Map<string, BidCommitChain>> {
  const out = new Map<string, BidCommitChain>();
  if (pdas.length === 0) return out;
  const { value } = await rpc.getMultipleAccounts(pdas, { encoding: 'base64' }).send();
  value.forEach((info, i) => {
    if (!info) return;
    const dataField = info.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    const bytes = new Uint8Array(b64ToBytes.encode(b64));
    out.set(String(pdas[i]), accounts.getBidCommitDecoder().decode(bytes));
  });
  return out;
}

export interface ListBidsFilter {
  /** Filter to bids on a specific RFP. */
  rfpPda?: Address;
  /** Filter to bids placed by a specific provider wallet (the bid signer).
   *  In public mode this is the provider's main wallet.
   *  In private mode this is the ephemeral wallet (the main is NEVER on chain
   *  during bidding - only revealed post-award via the encrypted envelope). */
  providerWallet?: Address;
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
 *   80..112 provider Pubkey (the bid signer - main wallet in public mode,
 *           ephemeral wallet in private mode)
 *   112..144 commit_hash [u8;32]
 *   ...
 */
export async function listBids(filter: ListBidsFilter = {}): Promise<BidCommitWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [memcmp(0, BID_COMMIT_DISCRIMINATOR)];
  if (filter.rfpPda) {
    filters.push(memcmp(8, addressEncoder.encode(filter.rfpPda)));
  }
  if (filter.providerWallet) {
    // After the schema simplification, provider lives at offset 80 directly.
    filters.push(memcmp(80, addressEncoder.encode(filter.providerWallet)));
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
      // owned by the same program - shouldn't happen with discriminator filter
      // in place but defensive).
    }
  }

  // v1/v2 leak guard: the BidCommit discriminator is identical between
  // program versions (same Anchor account name), and `DELEGATION_PROGRAM_ID`
  // is shared across all programs that delegate to MagicBlock PER. So a
  // memcmp scan over the delegation program returns BOTH v1 and v2
  // delegated bids. Filter to bids whose `rfp` field references an Rfp
  // account currently owned by the v2 tender program — v1 bids point to
  // v1 RFPs which are owned by the v1 program and therefore drop out.
  const candidates = Array.from(out.values());
  if (candidates.length === 0) return candidates;
  const rfpPdas = Array.from(new Set(candidates.map((c) => String(c.data.rfp))));
  const owners = await rpc.getMultipleAccounts(rfpPdas as Address[], { encoding: 'base64' }).send();
  const v2Rfps = new Set<string>();
  for (let i = 0; i < owners.value.length; i++) {
    const info = owners.value[i];
    if (info && info.owner === tenderProgramId) v2Rfps.add(rfpPdas[i]);
  }
  return candidates.filter((c) => v2Rfps.has(String(c.data.rfp)));
}

/* -------------------------------------------------------------------------- */
/* Convenience formatters - translate on-chain types into UI-friendly shapes. */
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

/** Maps RfpStatus enum (codama) to its on-chain string.
 *  MUST stay in sync with `programs/tender/src/state/rfp.rs::RfpStatus`. */
export function rfpStatusToString(status: RfpChain['status']): string {
  // Codama serializes Anchor enums as their declared order. Order below
  // mirrors the Rust enum exactly - any reordering on chain MUST update here.
  const names = [
    'draft', // 0
    'open', // 1
    'bidsclosed', // 2
    'reveal', // 3
    'awarded', // 4 - winner picked, not yet funded
    'funded', // 5 - escrow funded
    'inprogress', // 6 - at least one milestone started
    'completed', // 7
    'cancelled', // 8
    'ghostedbybuyer', // 9
    'disputed', // 10
    'expired', // 11 - reveal window closed without an award (terminal)
  ];
  return names[status as unknown as number] ?? 'unknown';
}

export function bidderVisibilityToString(v: RfpChain['bidderVisibility']): 'public' | 'buyer_only' {
  return (v as unknown as number) === 0 ? 'public' : 'buyer_only';
}

/** On-chain bid status string. Order MUST mirror
 *  `programs/tender/src/state/bid.rs::BidStatus` exactly. The codama
 *  decoder yields the variant index as a number — we name them here so
 *  consumers can branch on a stable string instead of memorizing the
 *  enum order. */
export type BidStatusString = 'initializing' | 'committed' | 'selected' | 'withdrawn' | 'expired';

export function bidStatusToString(s: BidCommitChain['status']): BidStatusString {
  const names: BidStatusString[] = [
    'initializing', // 0
    'committed', // 1
    'selected', // 2 — the only "winner" state; gates provider-side post-award actions
    'withdrawn', // 3
    'expired', // 4
  ];
  return names[s as unknown as number] ?? 'committed';
}

/** v2: BuyerVisibility decoder. Public=0, Private=1 — mirrors the on-chain
 *  enum order in `programs/tender/src/state/rfp.rs::BuyerVisibility`. */
export function buyerVisibilityToString(v: RfpChain['buyerVisibility']): 'public' | 'private' {
  return (v as unknown as number) === 0 ? 'public' : 'private';
}

/** Hex-encode a byte array (for commit_hash display and the like). */
/* -------------------------------------------------------------------------- */
/* Milestone, Escrow, Reputation reads (Day 7 additions)                      */
/* -------------------------------------------------------------------------- */

export type MilestoneStateChain = ReturnType<
  ReturnType<typeof accounts.getMilestoneStateDecoder>['decode']
>;
export type EscrowChain = ReturnType<ReturnType<typeof accounts.getEscrowDecoder>['decode']>;
export type BuyerReputationChain = ReturnType<
  ReturnType<typeof accounts.getBuyerReputationDecoder>['decode']
>;
export type ProviderReputationChain = ReturnType<
  ReturnType<typeof accounts.getProviderReputationDecoder>['decode']
>;

const utf = getUtf8Encoder();

export async function findEscrowPda(rfp: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('escrow'), addressEncoder.encode(rfp)],
  });
}

export async function findMilestonePda(
  rfp: Address,
  index: number,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('milestone'), addressEncoder.encode(rfp), new Uint8Array([index])],
  });
}

export async function findBuyerReputationPda(buyer: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('buyer_rep'), addressEncoder.encode(buyer)],
  });
}

export async function findProviderReputationPda(provider: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('provider_rep'), addressEncoder.encode(provider)],
  });
}

export async function findTreasuryPda(): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: tenderProgramId,
    seeds: [utf.encode('treasury')],
  });
}

export async function fetchEscrow(rfp: Address): Promise<EscrowChain | null> {
  const [pda] = await findEscrowPda(rfp);
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataField = value.data;
  const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
  return accounts.getEscrowDecoder().decode(new Uint8Array(b64ToBytes.encode(b64)));
}

export async function fetchMilestones(
  rfp: Address,
  count: number,
): Promise<(MilestoneStateChain | null)[]> {
  if (count === 0) return [];
  // Derive every milestone PDA in parallel (no RPC), then fetch all of
  // them in ONE `getMultipleAccounts` call instead of N parallel
  // `getAccountInfo` calls. Solana RPC accepts up to 100 accounts per
  // batch — a milestone count of 8 (the program's max) fits trivially.
  // Cuts dashboard RPC volume by ~7N for any project with milestones.
  const pdas = await Promise.all(Array.from({ length: count }, (_, i) => findMilestonePda(rfp, i)));
  const { value } = await rpc
    .getMultipleAccounts(
      pdas.map(([pda]) => pda),
      { encoding: 'base64' },
    )
    .send();
  return value.map((info) => {
    if (!info) return null;
    const dataField = info.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    return accounts.getMilestoneStateDecoder().decode(new Uint8Array(b64ToBytes.encode(b64)));
  });
}

export async function fetchBuyerReputation(buyer: Address): Promise<BuyerReputationChain | null> {
  const [pda] = await findBuyerReputationPda(buyer);
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataField = value.data;
  const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
  return accounts.getBuyerReputationDecoder().decode(new Uint8Array(b64ToBytes.encode(b64)));
}

export async function fetchProviderReputation(
  provider: Address,
): Promise<ProviderReputationChain | null> {
  const [pda] = await findProviderReputationPda(provider);
  const { value } = await rpc.getAccountInfo(pda, { encoding: 'base64' }).send();
  if (!value) return null;
  const dataField = value.data;
  const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
  return accounts.getProviderReputationDecoder().decode(new Uint8Array(b64ToBytes.encode(b64)));
}

/* -------------------------------------------------------------------------- */
/* Reputation list reads (leaderboard, dashboard)                              */
/* -------------------------------------------------------------------------- */

export interface BuyerReputationWithAddress {
  /** PDA address (derived from `["buyer_rep", buyer]`). */
  address: Address;
  data: BuyerReputationChain;
}

export interface ProviderReputationWithAddress {
  address: Address;
  data: ProviderReputationChain;
}

/**
 * List every `BuyerReputation` account on-chain. Used by `/leaderboard` and
 * dashboard surfaces. Defensive: drop accounts whose decode fails (likely a
 * stale layout from a pre-upgrade deploy) instead of throwing the whole list.
 *
 * The `dataSlice` optimization isn't applied because the BuyerReputation
 * struct is small (~75 bytes) - reading the full account is already cheap.
 */
export async function listBuyerReputations(): Promise<BuyerReputationWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [
    memcmp(0, accounts.BUYER_REPUTATION_DISCRIMINATOR),
  ];
  const result = await rpc
    .getProgramAccounts(tenderProgramId, { encoding: 'base64', filters })
    .send();
  return result
    .map(({ pubkey, account }) => {
      const dataField = account.data;
      const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
      const bytes = new Uint8Array(b64ToBytes.encode(b64));
      try {
        return {
          address: pubkey as Address,
          data: accounts.getBuyerReputationDecoder().decode(bytes),
        };
      } catch (e) {
        console.warn(`[listBuyerReputations] decode failed for ${pubkey}: ${(e as Error).message}`);
        return null;
      }
    })
    .filter((r): r is BuyerReputationWithAddress => r != null);
}

/** List every `ProviderReputation` account on-chain. */
export async function listProviderReputations(): Promise<ProviderReputationWithAddress[]> {
  const filters: GetProgramAccountsMemcmpFilter[] = [
    memcmp(0, accounts.PROVIDER_REPUTATION_DISCRIMINATOR),
  ];
  const result = await rpc
    .getProgramAccounts(tenderProgramId, { encoding: 'base64', filters })
    .send();
  return result
    .map(({ pubkey, account }) => {
      const dataField = account.data;
      const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
      const bytes = new Uint8Array(b64ToBytes.encode(b64));
      try {
        return {
          address: pubkey as Address,
          data: accounts.getProviderReputationDecoder().decode(bytes),
        };
      } catch (e) {
        console.warn(
          `[listProviderReputations] decode failed for ${pubkey}: ${(e as Error).message}`,
        );
        return null;
      }
    })
    .filter((r): r is ProviderReputationWithAddress => r != null);
}

export function milestoneStatusToString(s: MilestoneStateChain['status']): string {
  // Codama generates `MilestoneStatus` as a TS numeric enum (Pending=0, ...),
  // so the decoder yields a NUMBER, not a string or {__kind: ...} object.
  // Order MUST mirror the Rust enum in `programs/tender/src/state/escrow.rs`
  // - any reordering there has to update this table too.
  const names = [
    'pending', // 0
    'started', // 1
    'submitted', // 2
    'accepted', // 3
    'released', // 4
    'disputed', // 5
    'disputeresolved', // 6
    'disputedefault', // 7
    'cancelledbybuyer', // 8
  ];
  // biome-ignore lint/suspicious/noExplicitAny: runtime introspection covers both numeric-enum and legacy string / discriminated-union shapes
  const v = s as any;
  if (typeof v === 'number') return names[v] ?? `unknown(${v})`;
  if (typeof v === 'string') return v.toLowerCase();
  if (v && typeof v === 'object' && '__kind' in v) return String(v.__kind).toLowerCase();
  return String(s);
}

export function bytesToHex(bytes: ReadonlyUint8Array | Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

void bytesToB64; // tree-shake guard - exported for callers that need the inverse later
