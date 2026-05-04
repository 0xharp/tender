/**
 * SNS resolution helpers for the tendr identity layer (devnet).
 *
 * ====================== PRIVACY INVARIANT (CRITICAL) =========================
 *
 * SNS is a DISPLAY-LAYER ENHANCEMENT for ALREADY-PUBLIC wallets only.
 *
 * Never resolve SNS for:
 *   - per-RFP ephemeral bid signers (used in private-bidder mode)
 *   - any wallet whose linkage to a real-world identity has not already
 *     been established on chain via a verified path (e.g., the binding
 *     signature from `select_bid` for private-mode winners)
 *
 * Tendr-issued subdomains live on devnet under our `tendr.sol` parent.
 * Resolution is bounded to that parent (we never query global primary
 * domains, never SNS-query an ephemeral wallet's pubkey). Even an
 * accidentally-resolved ephemeral would just hit our parent+owner
 * `getProgramAccounts` filter and return zero results — but the
 * convention is "don't resolve ephemerals at all".
 *
 * Enforcement is a code convention, not a runtime check. The bid-composer
 * flow has a behavioral test asserting this invariant holds in the only
 * place it could practically break.
 *
 * ============================================================================
 *
 * Migration note: this module previously called `getPrimaryDomain` /
 * `getPrimaryDomainsBatch` from `@solana-name-service/sns-sdk-kit`
 * against MAINNET, surfacing a wallet's globally-set primary `.sol`
 * name. After switching to a tendr-issued subdomain model on devnet,
 * we resolve only against our own parent — wallets that had a mainnet
 * primary set (e.g. `sharpre.sol`) no longer surface here unless the
 * same wallet has also claimed a `.tendr.sol`. This is intentional;
 * the value prop changed from "see your existing Solana identity" to
 * "claim your portable tendr identity."
 */
import type {
  Address,
  GetAccountInfoApi,
  GetMultipleAccountsApi,
  GetProgramAccountsApi,
  GetTokenLargestAccountsApi,
  Rpc,
} from '@solana/kit';

import {
  deriveTendrSubdomainAddress,
  resolveTendrSubdomain,
  resolveTendrSubdomainsBulk,
} from './devnet/resolve';

const SOL_SUFFIX = '.sol';
const TENDR_PARENT = 'tendr';
const TENDR_SUFFIX = `.${TENDR_PARENT}${SOL_SUFFIX}`;

/** Strip leading `@` and trailing `.sol` so we can normalize whatever
 *  the user types in. Lowercase-coerced. */
export function normalizeSnsInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('@')) s = s.slice(1);
  if (s.endsWith(SOL_SUFFIX)) s = s.slice(0, -SOL_SUFFIX.length);
  return s;
}

/** Append `.sol` if not present. */
export function withSolSuffix(name: string): string {
  return name.toLowerCase().endsWith(SOL_SUFFIX) ? name : `${name}${SOL_SUFFIX}`;
}

/** RPC capability typings — every read path here uses kit RPCs. */
type SnsReadRpc = Rpc<
  GetAccountInfoApi & GetMultipleAccountsApi & GetProgramAccountsApi & GetTokenLargestAccountsApi
>;

/**
 * FORWARD: human-typed name → wallet address.
 *
 * Bounded to `*.tendr.sol`. Inputs like `harp.tendr.sol`, `harp.tendr`,
 * `@harp.tendr.sol`, and `harp` (bare leaf — auto-promoted to tendr
 * parent) all resolve to the same wallet. Anything that doesn't end in
 * `.tendr` after normalization returns null (we don't resolve other
 * `.sol` namespaces — that's intentional scope).
 */
export async function resolveSnsToWallet(
  rpc: SnsReadRpc,
  rawName: string,
): Promise<Address | null> {
  const normalized = normalizeSnsInput(rawName);
  if (normalized.length === 0) return null;
  // Accept `harp` (bare leaf), `harp.tendr` (with parent), or
  // `harp.tendr.sol` (already normalized to `harp.tendr` above).
  let leaf: string;
  if (normalized.includes('.')) {
    if (!normalized.endsWith(`.${TENDR_PARENT}`)) return null;
    leaf = normalized.slice(0, -(TENDR_PARENT.length + 1));
  } else {
    leaf = normalized;
  }
  if (leaf.length === 0) return null;
  try {
    const subAddr = await deriveTendrSubdomainAddress(leaf);
    const { value } = await rpc.getAccountInfo(subAddr, { encoding: 'base64' }).send();
    if (!value) return null;
    // Read the owner field from the NameRegistryState header (bytes 32..64).
    const dataField = value.data;
    const b64 = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    const bytes = base64ToBytes(b64);
    if (bytes.byteLength < 64) return null;
    const ownerBytes = bytes.subarray(32, 64);
    const ownerB58 = bytesToBase58(ownerBytes);
    return ownerB58 as Address;
  } catch {
    return null;
  }
}

/**
 * REVERSE: wallet → tendr identity (`<handle>.tendr.sol`) or null.
 *
 * Used by HashLink + every wallet-display surface. Bounded to our parent
 * domain, so the only names this returns are `<handle>.tendr.sol`.
 *
 * PRIVACY INVARIANT: only call for ALREADY-PUBLIC wallets. Don't pass
 * ephemeral bid signers. See top-of-file note.
 */
export async function resolveWalletToSns(rpc: SnsReadRpc, wallet: Address): Promise<string | null> {
  try {
    const hit = await resolveTendrSubdomain(rpc, wallet);
    return hit?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * BULK REVERSE: many wallets → tendr identities in one round-trip.
 *
 * Used by the leaderboard. Internally fetches every tendr subdomain in
 * one `getProgramAccounts` call, then parallel-fetches the reverse
 * accounts only for owners we care about.
 *
 * PRIVACY INVARIANT: only pass ALREADY-PUBLIC wallets.
 */
export async function resolveWalletsToSns(
  rpc: SnsReadRpc,
  wallets: Address[],
): Promise<Map<Address, string | null>> {
  const out = new Map<Address, string | null>();
  if (wallets.length === 0) return out;
  const unique = Array.from(new Set(wallets));
  try {
    const map = await resolveTendrSubdomainsBulk(rpc, unique);
    for (const w of unique) out.set(w, map.get(w) ?? null);
  } catch {
    // Whole-batch failure → render every wallet as null (truncated-hash
    // fallback). SNS is a UX nicety, not load-bearing.
    for (const w of unique) out.set(w, null);
  }
  return out;
}

// --- internal: tiny base58 + base64 helpers ----------------------------------
//
// We avoid pulling in @solana/kit's getBase58Decoder / getBase64Encoder here
// to keep this module's bundle small (it's imported by the React hook in
// browser code). Both helpers are <30 LOC and cover the only conversion
// shape we need (raw bytes ↔ base58 string for pubkey, base64 ↔ raw bytes
// for getAccountInfo `data` field).

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bytesToBase58(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  // Count leading zero bytes — encode as leading '1' chars.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert from base256 to base58 via repeated division (big-endian).
  const tmp = new Uint8Array(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < tmp.length) {
    let remainder = 0;
    let allZero = true;
    for (let i = start; i < tmp.length; i++) {
      const v = (remainder << 8) + tmp[i]!;
      tmp[i] = (v / 58) | 0;
      remainder = v % 58;
      if (tmp[i] !== 0) allZero = false;
    }
    out.push(remainder);
    if (allZero) break;
    while (start < tmp.length && tmp[start] === 0) start++;
  }
  out.reverse();
  return '1'.repeat(zeros) + out.map((n) => BS58_ALPHABET[n]).join('');
}

// Re-export for the unchanged callers `withSolSuffix` consumers in the
// codebase. (The old module exported it; existing imports continue to work.)
