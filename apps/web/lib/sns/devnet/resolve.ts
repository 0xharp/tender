/**
 * Devnet `wallet → harp.tendr.sol` resolution — KIT-NATIVE.
 *
 * Uses `@solana/kit`'s Rpc + getProgramAccounts directly, so this layer
 * composes cleanly with `snsRpc` (which is a kit Rpc, not a web3.js v1
 * Connection). The bonfida v1 SDK is intentionally NOT imported here —
 * we re-implement the small slice of address-derivation + name-decoding
 * we need (sha256 PDA derivation + reverse-lookup parsing) so the read
 * path stays free of v1/v2 boundary issues.
 *
 * Resolution mechanic: the in-app `useSnsName(wallet)` hook calls
 * `resolveTendrSubdomain(snsRpc, wallet)`. We do NOT touch SNS's global
 * primary-domain mechanism (`getPrimaryDomain`) — instead we look for a
 * subdomain account whose `parent == tendr.sol` AND `owner == wallet`,
 * which means a user gets a name shown the moment they claim, with NO
 * second user signature needed.
 *
 * NameRegistryState header layout (verified against the SPL Name Service
 * program source):
 *   bytes  0..32   parent
 *   bytes 32..64   owner
 *   bytes 64..96   class
 *   bytes 96..end  arbitrary data section (empty for tendr subdomains;
 *                  the human-readable name lives in the reverse account)
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  type Address,
  type GetAccountInfoApi,
  type GetProgramAccountsApi,
  type GetProgramAccountsMemcmpFilter,
  type Rpc,
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
} from '@solana/kit';

/** Minimal RPC capability set this resolver needs. Narrowed so callers
 *  with a more constrained Rpc type (e.g. the shared `SnsReadRpc` shape
 *  in lib/sns/resolve.ts) don't have to upcast. */
type DevnetReadRpc = Rpc<GetAccountInfoApi & GetProgramAccountsApi>;

const NAME_PROGRAM = address('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX');
const DEVNET_SOL_TLD = address('5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2');
const DEVNET_REVERSE_LOOKUP_CLASS = address('7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H');
const HASH_PREFIX = 'SPL Name Service';
const TENDR_PARENT_NAME = 'tendr';
const ZERO_32 = new Uint8Array(32);

const PARENT_OFFSET = 0;
const OWNER_OFFSET = 32;
const HEADER_LEN = 96;

const addressEncoder = getAddressEncoder();
const b58 = getBase58Decoder();
const b64 = getBase64Encoder();
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/**
 * Hash a name with the SPL Name Service hash prefix. Mirrors the on-chain
 * derivation used by every Name Service instruction.
 */
function getHashedName(name: string): Uint8Array {
  return sha256(utf8.encode(HASH_PREFIX + name));
}

/**
 * Derive a name account address from `(name, parent)`. For top-level
 * domains pass `parent = DEVNET_SOL_TLD`; for subdomains pass the parent
 * domain's pubkey. Class is always zero for our use cases.
 */
async function deriveDomainAddress(name: string, parent: Address): Promise<Address> {
  const hashed = getHashedName(name);
  const [pda] = await getProgramDerivedAddress({
    programAddress: NAME_PROGRAM,
    seeds: [hashed, ZERO_32, addressEncoder.encode(parent)],
  });
  return pda;
}

/**
 * Derive the reverse-lookup account address for a domain. The reverse
 * account is derived from:
 *   seeds = [
 *     sha256("SPL Name Service" + domainAddress.toBase58()),
 *     REVERSE_LOOKUP_CLASS,
 *     parent  ← INCLUDED for subdomains, ZERO_32 for top-level domains
 *   ]
 *
 * IMPORTANT: bonfida's exported `reverseLookup` helper omits parent in
 * the derivation regardless — meaning it produces the wrong address for
 * subdomains and silently fails. createSubdomain DOES create the
 * reverse account at the parent-aware address (via its `getReverseKeySync(name, true)`
 * helper), so any code that wants to read tendr subdomain reverses MUST
 * include parent in the seeds. We only call this for tendr subdomains,
 * so parent is always required.
 */
async function deriveReverseAddress(
  domainAddress: Address,
  parent: Address,
): Promise<Address> {
  // Hash the BASE58 STRING of the domain pubkey, NOT the pubkey bytes.
  // This is the convention SPL Name Service inherited from earlier versions.
  const hashed = getHashedName(domainAddress);
  const [pda] = await getProgramDerivedAddress({
    programAddress: NAME_PROGRAM,
    seeds: [
      hashed,
      addressEncoder.encode(DEVNET_REVERSE_LOOKUP_CLASS),
      addressEncoder.encode(parent),
    ],
  });
  return pda;
}

/**
 * Cached `tendr.sol` parent pubkey — derivation is deterministic +
 * cheap, but caching saves a few PDA computations across calls.
 */
let _tendrParentCache: Address | null = null;
async function tendrParentAddress(): Promise<Address> {
  if (_tendrParentCache) return _tendrParentCache;
  _tendrParentCache = await deriveDomainAddress(TENDR_PARENT_NAME, DEVNET_SOL_TLD);
  return _tendrParentCache;
}

/**
 * Parse the reverse-lookup account's data section into the leaf name.
 *
 * Format (matches `deserializeReverse` in @bonfida/spl-name-service):
 *   bytes 0..4    4-byte LE u32 length
 *   bytes 4..4+N  UTF-8 name bytes
 *
 * Subdomains are stored with a leading `\0` byte before the leaf (SNS
 * convention — the `createSubdomain` ix passes name = "\0" + leaf), so
 * for `isSub=true` we strip that leading null. There is NO 32-byte
 * parent prefix — earlier comments here were wrong.
 */
function parseReverseData(data: Uint8Array, isSub: boolean): string | null {
  if (data.byteLength < 4) return null;
  const len = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  if (data.byteLength < 4 + len) return null;
  let name = utf8Decoder.decode(data.subarray(4, 4 + len));
  if (isSub && name.startsWith('\0')) name = name.slice(1);
  return name;
}

export interface TendrSubdomainHit {
  /** PDA of the subdomain account itself. */
  subdomainAddress: Address;
  /** Fully-qualified name, e.g. `harp.tendr.sol`. */
  name: string;
}

/**
 * Look up the `tendr.sol` subdomain owned by `wallet` on devnet, if any.
 * Returns null if no claim exists yet. Two RPC calls: one
 * `getProgramAccounts` (with two memcmp filters) + one `getAccountInfo`
 * for the reverse-lookup account.
 */
export async function resolveTendrSubdomain(
  rpc: DevnetReadRpc,
  wallet: Address,
): Promise<TendrSubdomainHit | null> {
  const tendrParent = await tendrParentAddress();
  const filters: GetProgramAccountsMemcmpFilter[] = [
    // biome-ignore lint/suspicious/noExplicitAny: kit brands base58 strings; runtime is plain string.
    { memcmp: { offset: BigInt(PARENT_OFFSET), bytes: tendrParent as any, encoding: 'base58' } },
    // biome-ignore lint/suspicious/noExplicitAny: same nominal cast
    { memcmp: { offset: BigInt(OWNER_OFFSET), bytes: wallet as any, encoding: 'base58' } },
  ];
  const accounts = await rpc
    .getProgramAccounts(NAME_PROGRAM, { encoding: 'base64', filters })
    .send();
  if (accounts.length === 0) return null;
  const subdomainAddress = accounts[0]!.pubkey;
  const name = await reverseLookupTendr(rpc, subdomainAddress);
  if (!name) return null;
  return { subdomainAddress, name };
}

/**
 * Bulk variant for the leaderboard. One getProgramAccounts call returns
 * EVERY tendr subdomain (typically a few hundred at most for a long
 * time), then we filter to the wallets we care about and parallel-fetch
 * the reverse-lookup accounts. Single round-trip + parallel lookup.
 */
export async function resolveTendrSubdomainsBulk(
  rpc: DevnetReadRpc,
  wallets: Address[],
): Promise<Map<Address, string>> {
  if (wallets.length === 0) return new Map();
  const tendrParent = await tendrParentAddress();
  const accounts = await rpc
    .getProgramAccounts(NAME_PROGRAM, {
      encoding: 'base64',
      filters: [
        // biome-ignore lint/suspicious/noExplicitAny: kit nominal cast
        { memcmp: { offset: BigInt(PARENT_OFFSET), bytes: tendrParent as any, encoding: 'base58' } },
      ],
    })
    .send();
  const walletSet = new Set<string>(wallets);
  const matched: { subAddr: Address; ownerB58: Address }[] = [];
  for (const a of accounts) {
    // a.account.data is a tuple [b64-string, encoding] when encoding=base64.
    const dataField = a.account.data;
    const b64Str = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
    const bytes = new Uint8Array(b64.encode(b64Str));
    if (bytes.byteLength < OWNER_OFFSET + 32) continue;
    const ownerBytes = bytes.subarray(OWNER_OFFSET, OWNER_OFFSET + 32);
    const ownerB58 = b58.decode(ownerBytes) as Address;
    if (walletSet.has(ownerB58)) {
      matched.push({ subAddr: a.pubkey, ownerB58 });
    }
  }
  if (matched.length === 0) return new Map();
  const named = await Promise.all(
    matched.map(async ({ subAddr, ownerB58 }) => {
      const name = await reverseLookupTendr(rpc, subAddr);
      return name ? ([ownerB58, name] as const) : null;
    }),
  );
  const map = new Map<Address, string>();
  for (const r of named) if (r) map.set(r[0], r[1]);
  return map;
}

/**
 * Read the reverse-lookup account for a tendr subdomain and return the
 * fully-qualified name. Returns null if the reverse account is missing
 * (shouldn't happen in our mint flow, which always creates the reverse).
 */
async function reverseLookupTendr(
  rpc: DevnetReadRpc,
  subdomainAddress: Address,
): Promise<string | null> {
  const tendrParent = await tendrParentAddress();
  const reverseAddr = await deriveReverseAddress(subdomainAddress, tendrParent);
  const { value } = await rpc
    .getAccountInfo(reverseAddr, { encoding: 'base64' })
    .send();
  if (!value) return null;
  const dataField = value.data;
  const b64Str = Array.isArray(dataField) ? (dataField[0] as string) : (dataField as string);
  const bytes = new Uint8Array(b64.encode(b64Str));
  // Skip the 96-byte NameRegistryState header to reach the data section.
  if (bytes.byteLength <= HEADER_LEN) return null;
  const dataSection = bytes.subarray(HEADER_LEN);
  const leaf = parseReverseData(dataSection, true /* isSub */);
  if (!leaf) return null;
  return `${leaf}.${TENDR_PARENT_NAME}.sol`;
}

/**
 * Public helper to derive a subdomain's address before it exists on-chain.
 * Used by forward resolution (`*.tendr.sol` → wallet) and availability
 * checks (`isTendrHandleTaken`).
 *
 * SNS subdomain convention: the on-chain name account is registered with
 * name = `"\0" + handle`. The leading null byte is what the SDK uses to
 * distinguish a subdomain registration from a top-level domain that
 * happens to be parented under another domain. createSubdomain prepends
 * the `\0` internally; we have to do the same here so our derived PDA
 * matches the address bonfida actually stored the account at.
 *
 * Without the `\0` prefix:
 *   - forward resolve `harp.tendr.sol → wallet` queries the wrong PDA
 *     and returns null (page redirects to the fallback / 404)
 *   - `isTendrHandleTaken('harp')` queries the wrong PDA and reports
 *     "available" even when the handle is genuinely claimed
 */
export async function deriveTendrSubdomainAddress(handle: string): Promise<Address> {
  const tendrParent = await tendrParentAddress();
  return deriveDomainAddress(`\0${handle}`, tendrParent);
}

/**
 * Public helper to fetch `tendr.sol`'s on-chain address. Cached.
 */
export async function getTendrParentAddress(): Promise<Address> {
  return tendrParentAddress();
}

/**
 * Public helper: check if a handle is already taken on devnet. Returns
 * true if the account exists at the derived address.
 */
export async function isTendrHandleTaken(
  rpc: DevnetReadRpc,
  handle: string,
): Promise<boolean> {
  const subAddr = await deriveTendrSubdomainAddress(handle);
  const { value } = await rpc.getAccountInfo(subAddr, { encoding: 'base64' }).send();
  return value !== null;
}
