/**
 * Keychain enumeration — discover everything a user owns in their HD
 * keychain by deriving ephemerals 0..N and memcmp-scanning the chain.
 *
 * Two surfaces:
 *
 *   - `enumerateOwnedRfps(masterSeed)` → all RFPs where the buyer is one
 *     of the user's HD-derived buyer ephemerals (private-mode RFPs only;
 *     public-mode RFPs are surfaced via the existing main-wallet memcmp
 *     and unioned at the page level).
 *
 *   - `enumerateOwnBids(masterSeed)` → all bids placed via HD-derived
 *     bidder ephemerals (private-bidder mode). The headline UX win:
 *     a provider can finally see *all* their private bids in one place
 *     after one master sign — no per-RFP signing roulette to discover
 *     whether they bid somewhere.
 *
 * Both also expose `nextBuyerIndex` / `nextBidderIndex` helpers — the
 * smallest unused index in the user's keychain, used at create time so
 * failed-create gaps get reused on the next attempt.
 *
 * Privacy property: the scan is purely client-side. We send normal
 * `getProgramAccounts` memcmp queries to the RPC; the RPC sees the
 * candidate ephemeral pubkeys (which are cryptographically unlinkable
 * to each other or to the main wallet) and our request pattern.
 * **We never send the master seed or main wallet to anyone.**
 */
import { type Address, getAddressEncoder, getBase64Encoder } from '@solana/kit';
import { accounts, findBidPda } from '@tender/tender-client';

import { deriveBidderEphemeral, deriveBuyerEphemeral } from '@/lib/crypto/keychain';
import {
  type BidCommitWithAddress,
  type RfpWithAddress,
  listBids,
  listRfps,
} from '@/lib/solana/chain-reads';
import { rpc } from '@/lib/solana/client';

const b64ToBytes = getBase64Encoder();
const addressEncoder = getAddressEncoder();

/**
 * Default scan window — derive ephemerals 0..31 in parallel and scan.
 * Covers >99% of practical users; can be raised per-call if a power
 * user genuinely has more.
 *
 * Empirically tuned against RPC Fast's devnet endpoint
 * (apps/web/scripts/load-test-keychain-enumerate.mjs):
 *   16 parallel → 582ms
 *   32 parallel → 619ms   ← chosen as default
 *   64 parallel → 1693ms  ← single slow tail call dominates
 *
 * The cliff between 32 and 64 is the RPC's connection-pool limit;
 * past 32 a tail call (~1.7s p99) drags the wall time up. The
 * `enumerate` loop auto-doubles past this default if a window comes
 * back full of hits, so heavy users still get full coverage at the
 * cost of a few extra round-trips — not a tail-latency cliff on the
 * common case.
 */
export const DEFAULT_SCAN_WINDOW = 32;

/** Hard cap on how far we'll scan even with auto-doubling enabled. */
export const HARD_CAP = 1024;

/**
 * Each enumerated RFP/bid row, paired with the index that produced it.
 * Index lets the caller re-derive the keypair for signing follow-up
 * txs without re-scanning.
 */
export interface OwnedRfpHit {
  index: number;
  ephemeralPubkey: Address;
  rfp: RfpWithAddress;
}

export interface OwnBidHit {
  index: number;
  ephemeralPubkey: Address;
  bid: BidCommitWithAddress;
}

/**
 * Enumerate all RFPs owned by HD buyer ephemerals 0..scanWindow.
 *
 * Auto-doubles past `scanWindow` if hits land in the upper quarter of
 * the current window — covers heavy users without paying the full
 * `HARD_CAP` RPC cost on every load. Bounded at HARD_CAP.
 */
export async function enumerateOwnedRfps(
  masterSeed: Uint8Array,
  scanWindow: number = DEFAULT_SCAN_WINDOW,
): Promise<OwnedRfpHit[]> {
  return enumerate(masterSeed, scanWindow, 'buyer');
}

/**
 * Enumerate all bids placed via HD bidder ephemerals 0..scanWindow.
 * Same auto-doubling as `enumerateOwnedRfps`.
 */
export async function enumerateOwnBids(
  masterSeed: Uint8Array,
  scanWindow: number = DEFAULT_SCAN_WINDOW,
): Promise<OwnBidHit[]> {
  return enumerate(masterSeed, scanWindow, 'bidder');
}

/**
 * Find the smallest unused buyer-ephemeral index. Used at create time
 * so race conditions / failed creates leave gaps that get reused on
 * the next attempt.
 */
export async function nextBuyerIndex(
  masterSeed: Uint8Array,
  scanWindow: number = DEFAULT_SCAN_WINDOW,
): Promise<number> {
  const owned = await enumerateOwnedRfps(masterSeed, scanWindow);
  return firstGap(
    owned.map((o) => o.index),
    scanWindow,
  );
}

/** Same as `nextBuyerIndex` but for bidder ephemerals. */
export async function nextBidderIndex(
  masterSeed: Uint8Array,
  scanWindow: number = DEFAULT_SCAN_WINDOW,
): Promise<number> {
  const owned = await enumerateOwnBids(masterSeed, scanWindow);
  return firstGap(
    owned.map((o) => o.index),
    scanWindow,
  );
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

type Role = 'buyer' | 'bidder';

// Internal generic enumerator. Returns hit shape inferred from role.
async function enumerate(
  masterSeed: Uint8Array,
  initialWindow: number,
  role: 'buyer',
): Promise<OwnedRfpHit[]>;
async function enumerate(
  masterSeed: Uint8Array,
  initialWindow: number,
  role: 'bidder',
): Promise<OwnBidHit[]>;
async function enumerate(
  masterSeed: Uint8Array,
  initialWindow: number,
  role: Role,
): Promise<OwnedRfpHit[] | OwnBidHit[]> {
  // Derive HARD_CAP ephemeral pubkeys upfront (pure crypto, no RPC).
  // Then issue ONE listRfps()/listBids() (no memcmp filter) and locally
  // intersect with the derived pubkey set. This replaces the previous
  // N-parallel-getProgramAccounts pattern (32 separate RPC calls per
  // role per enumerate run, scaling up to HARD_CAP under auto-doubling)
  // with a single full-table scan + a hash-set lookup. For Tender's
  // current chain footprint (low-thousands of RFPs/bids on devnet) the
  // single full scan response is tiny and the RPC-side cost is the same
  // or lower vs N filtered scans. Net dashboard load drops by ~60-120
  // RPC calls per HD-active session.
  //
  // The auto-doubling loop is preserved in shape — we still derive a
  // limited pubkey window first, double if the upper quarter has hits,
  // bounded at HARD_CAP — but each iteration costs a single RPC call
  // instead of N. Empty windows still terminate the scan early.
  void initialWindow; // window-doubling now happens entirely in the derive loop

  const buyerHits: OwnedRfpHit[] = [];
  const bidderHits: OwnBidHit[] = [];

  // One chain query covers any ephemeral we might derive. Filtered to
  // discriminator only (no memcmp on buyer/provider) so the result set
  // is the universe of accounts; we filter by ephemeral-pubkey set
  // locally. v1/v2 leak guard inside listBids still applies.
  const [allRfps, allBids] = await Promise.all([
    role === 'buyer' ? listRfps() : Promise.resolve([] as RfpWithAddress[]),
    role === 'bidder' ? listBids() : Promise.resolve([] as BidCommitWithAddress[]),
  ]);

  let scanned = 0;
  let window = initialWindow;
  while (scanned < HARD_CAP) {
    const indices = Array.from({ length: window }, (_, i) => scanned + i);
    // Derive this batch of ephemerals in parallel (pure crypto).
    const ephemerals = await Promise.all(
      indices.map(async (i) => {
        const kp =
          role === 'buyer'
            ? await deriveBuyerEphemeral(masterSeed, i)
            : await deriveBidderEphemeral(masterSeed, i);
        return { index: i, pubkey: kp.publicKey.toBase58() as Address };
      }),
    );
    // Map ephemeral pubkey → index for local intersect.
    const ephByPubkey = new Map<string, number>();
    for (const { index, pubkey } of ephemerals) ephByPubkey.set(String(pubkey), index);

    // Local intersect against the single full listRfps()/listBids() pull.
    let hitsThisBatch = 0;
    if (role === 'buyer') {
      for (const rfp of allRfps) {
        const buyer = String(rfp.data.buyer);
        const idx = ephByPubkey.get(buyer);
        if (idx === undefined) continue;
        buyerHits.push({ index: idx, ephemeralPubkey: buyer as Address, rfp });
        hitsThisBatch += 1;
      }
    } else {
      for (const bid of allBids) {
        const provider = String(bid.data.provider);
        const idx = ephByPubkey.get(provider);
        if (idx === undefined) continue;
        bidderHits.push({ index: idx, ephemeralPubkey: provider as Address, bid });
        hitsThisBatch += 1;
      }
    }

    scanned += window;
    // Same early-termination heuristic as before.
    if (hitsThisBatch === 0) break;
    if (hitsThisBatch < Math.max(1, Math.floor(window / 4))) break;
    window = Math.min(window * 2, HARD_CAP - scanned);
    if (window <= 0) break;
  }
  return role === 'buyer' ? buyerHits : bidderHits;
}

/**
 * Optimized single-RFP variant of `enumerateOwnBids`. Used by surfaces
 * that only care about "did any of my HD bidder ephemerals bid on THIS
 * specific RFP?" — your-bid-panel, sweep-ephemeral-panel, etc.
 *
 * Why not just call `enumerateOwnBids` and filter? The general
 * enumerator does N parallel `getProgramAccounts` memcmp scans
 * (full-program-table scans on the RPC side, ~600ms). For one RFP we
 * can compute the deterministic bid PDA per ephemeral —
 *    bid_pda = PDA(["bid", rfp, provider])
 * — and do a single batched `getMultipleAccounts` call. Bid PDAs are
 * O(1) accountsdb lookups; one batch RPC call instead of 32. In
 * practice ~50-150ms total vs ~600ms for the general enumerator.
 *
 * Note: bids can be delegated to MagicBlock PER, in which case the
 * account owner is `DELEGATION_PROGRAM_ID`. `getMultipleAccounts`
 * returns the account regardless of owner, so this works for both
 * delegated and undelegated bids — no second query needed.
 */
export async function findOwnBidForRfp(
  masterSeed: Uint8Array,
  rfpPda: Address,
  scanWindow: number = DEFAULT_SCAN_WINDOW,
): Promise<OwnBidHit | null> {
  // Derive ephemerals + bid PDAs in parallel (no RPC).
  const candidates = await Promise.all(
    Array.from({ length: scanWindow }, async (_, index) => {
      const kp = await deriveBidderEphemeral(masterSeed, index);
      const provider = kp.publicKey.toBase58() as Address;
      // L0 (Public bidder mode) uses the provider's wallet bytes
      // directly as the seed. HD bidders are L0 — the privacy comes
      // from the ephemeral provider key, not from an opaque seed.
      // (L1 / opaque-seed mode is a separate codepath we don't scan.)
      const [bidPda] = await findBidPda({
        rfp: rfpPda,
        bidPdaSeed: new Uint8Array(addressEncoder.encode(provider)),
      });
      return { index, provider, bidPda };
    }),
  );

  // Single batched lookup. RPC accepts up to 100 addresses; 32 fits trivially.
  const { value } = await rpc
    .getMultipleAccounts(
      candidates.map((c) => c.bidPda),
      { encoding: 'base64' },
    )
    .send();

  for (let i = 0; i < value.length; i++) {
    const info = value[i];
    if (!info) continue;
    const dataField = info.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    const bytes = new Uint8Array(b64ToBytes.encode(b64));
    try {
      const decoded = accounts.getBidCommitDecoder().decode(bytes);
      const c = candidates[i];
      return {
        index: c.index,
        ephemeralPubkey: c.provider,
        bid: { address: c.bidPda, data: decoded },
      };
    } catch {
      // Account exists at this PDA but isn't a BidCommit (shouldn't
      // happen — PDAs are namespaced — but defensive).
    }
  }
  return null;
}

/**
 * Smallest non-negative integer not in `used`. Bounded by `scanWindow`
 * so we never search past what the caller actually scanned.
 */
function firstGap(used: number[], scanWindow: number): number {
  const set = new Set(used);
  for (let i = 0; i < scanWindow + set.size; i++) {
    if (!set.has(i)) return i;
  }
  // Pathological — caller scanned a contiguous range matching the
  // entire scanWindow. Fall through to next index.
  return scanWindow + set.size;
}
