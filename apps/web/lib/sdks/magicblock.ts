import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  createTopUpEscrowInstruction,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
  getAuthToken,
  permissionPdaFromAccount,
} from '@magicblock-labs/ephemeral-rollups-kit';
/**
 * MagicBlock Private Ephemeral Rollup (PER) - client-side wrapper.
 *
 * Provides:
 *   - Dual-connection RPC setup (base layer + ER)
 *   - TEE auth-token cache (one signature per session)
 *   - PDA helpers for the PER infra accounts (permission, buffer, delegation
 *     record, delegation metadata) needed by `delegate_bid`, `withdraw_bid`,
 *     `select_bid`, and `open_reveal_window` instructions.
 *
 * See `docs/PRIVACY-MODEL.md` for why we use PER and the time-locked-reveal
 * guarantee. See https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers
 * for the underlying SDK + endpoint specifics.
 */
import {
  type Address,
  type Rpc,
  type SolanaRpcApi,
  createSolanaRpc,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit';

import { tenderProgramId } from '@/lib/solana/client';

/* -------------------------------------------------------------------------- */
/* Constants - devnet endpoints for PER.                                      */
/* -------------------------------------------------------------------------- */

/**
 * TEE-capable validator pubkey for PER on devnet. We pass this as the
 * `validator` arg to `delegate_bid` so the bid lands on a TEE-backed validator
 * (PER privacy guarantee requires this - non-TEE validators can read account
 * data unprotected).
 */
export const PER_DEVNET_TEE_VALIDATOR: Address =
  'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo' as Address;

/** Default ER RPC base URL for the TEE validator on devnet. */
export const PER_DEVNET_TEE_RPC_URL =
  process.env.NEXT_PUBLIC_MAGICBLOCK_TEE_RPC_URL ?? 'https://devnet-tee.magicblock.app';

/** Re-exports - programs we reference in our instructions. */
export { DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID };

/* -------------------------------------------------------------------------- */
/* PDA helpers - Tender-specific wrappers.                                    */
/* -------------------------------------------------------------------------- */

/**
 * The full set of PER infrastructure account addresses needed for a single bid
 * delegation. Derived from the bid PDA - caller constructs this once per bid
 * and passes ALL of them explicitly to the delegate / withdraw / select ix
 * builders. We can't rely on codama's auto-derivation because it defaults all
 * `seeds::program` overrides to our program ID; the actual seeds are scoped
 * under either the delegation program (records/metadata) or the permission
 * program (permission + its own buffer).
 */
export interface PerBidAccounts {
  /** The delegated bid account itself (owned by our program before delegation). */
  bid: Address;
  /** Buffer for delegating the bid account; under our (owner) program. */
  bufferBid: Address;
  /** Delegation record for the bid account; under the delegation program. */
  delegationRecordBid: Address;
  /** Delegation metadata for the bid account; under the delegation program. */
  delegationMetadataBid: Address;
  /** Permission account; under the permission program. */
  permission: Address;
  /** Delegation buffer for the permission account; under the permission program. */
  bufferPermission: Address;
  /** Delegation record for the permission account; under the delegation program. */
  delegationRecordPermission: Address;
  /** Delegation metadata for the permission account; under the delegation program. */
  delegationMetadataPermission: Address;
}

export async function derivePerBidAccounts(
  bid: Address,
  ownerProgram: Address = tenderProgramId,
): Promise<PerBidAccounts> {
  const permission = await permissionPdaFromAccount(bid);
  const [
    bufferBid,
    delegationRecordBid,
    delegationMetadataBid,
    bufferPermission,
    delegationRecordPermission,
    delegationMetadataPermission,
  ] = await Promise.all([
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram(bid, ownerProgram),
    delegationRecordPdaFromDelegatedAccount(bid),
    delegationMetadataPdaFromDelegatedAccount(bid),
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram(permission, PERMISSION_PROGRAM_ID),
    delegationRecordPdaFromDelegatedAccount(permission),
    delegationMetadataPdaFromDelegatedAccount(permission),
  ]);
  return {
    bid,
    bufferBid,
    delegationRecordBid,
    delegationMetadataBid,
    permission,
    bufferPermission,
    delegationRecordPermission,
    delegationMetadataPermission,
  };
}

/* -------------------------------------------------------------------------- */
/* TEE auth - token cache + sign-on-demand.                                   */
/* -------------------------------------------------------------------------- */

/**
 * Per-(rpc, wallet) cached TEE auth token. The token lifetime is set by the
 * server (typically 1h+); we re-sign on miss or expiry. Cache is in-memory only,
 * keyed by `${rpcUrl}::${wallet}`.
 *
 * Using a module-scoped Map is fine: this code only runs in the browser, one
 * wallet active at a time, no cross-tab persistence required.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

const TOKEN_REFRESH_BUFFER_MS = 30_000; // refresh 30s before expiry

function cacheKey(rpcUrl: string, wallet: Address): string {
  return `${rpcUrl}::${wallet}`;
}

/**
 * Get a valid TEE auth token for the given wallet, signing a fresh challenge
 * if needed. Triggers exactly one wallet message-sign popup on miss/expiry.
 *
 * @param wallet  the user's wallet address (provider or buyer)
 * @param signMessage  closure that signs raw bytes via the wallet
 * @param rpcUrl  ER RPC base URL (defaults to PER_DEVNET_TEE_RPC_URL)
 */
export async function ensureTeeAuthToken(
  wallet: Address,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  rpcUrl: string = PER_DEVNET_TEE_RPC_URL,
): Promise<string> {
  const key = cacheKey(rpcUrl, wallet);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return cached.token;
  }
  const fresh = await getAuthToken(rpcUrl, wallet, signMessage);
  tokenCache.set(key, fresh);
  return fresh.token;
}

/** Drop the cached token for a wallet - forces a re-sign on next call. */
export function clearTeeAuthToken(wallet: Address, rpcUrl: string = PER_DEVNET_TEE_RPC_URL): void {
  tokenCache.delete(cacheKey(rpcUrl, wallet));
}

/* -------------------------------------------------------------------------- */
/* ER RPC client - token-bearing.                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build an `@solana/kit` RPC client pointed at the ER endpoint with the auth
 * token attached as a query param. The returned RPC behaves identically to a
 * base-layer RPC for read calls (`getAccountInfo`, etc.) - the difference is
 * that it routes against the ER and respects PER permission gating.
 */
export function ephemeralRpc(
  authToken: string,
  rpcUrl: string = PER_DEVNET_TEE_RPC_URL,
): Rpc<SolanaRpcApi> {
  return createSolanaRpc(`${rpcUrl}?token=${authToken}`);
}

/* -------------------------------------------------------------------------- */
/* Account fetch - ER-aware getAccountInfo with raw bytes.                    */
/* -------------------------------------------------------------------------- */

/**
 * Fetch a delegated account's raw data bytes from the ER. The PER permission
 * program enforces read access - if the caller's wallet isn't in the permission
 * set, the RPC returns `null` (account "not found" from their POV).
 *
 * Returns `null` if the account doesn't exist OR if the caller lacks read access.
 * Both cases are indistinguishable to the client - that's the privacy property.
 */
export async function fetchDelegatedAccountBytes(
  address: Address,
  rpc: Rpc<SolanaRpcApi>,
): Promise<Uint8Array | null> {
  const result = await rpc.getAccountInfo(address, { encoding: 'base64' }).send();
  if (!result.value) return null;
  const [b64] = result.value.data;
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

/* -------------------------------------------------------------------------- */
/* Owner-program ID for our bid (used by buffer-PDA derivation).              */
/* -------------------------------------------------------------------------- */

/** The Tender program owns the BidCommit account before delegation; pass this
 *  to `delegateBufferPdaFromDelegatedAccountAndOwnerProgram` for non-permission
 *  delegated accounts (we only need it for the permission infra above). */
export const TENDER_OWNER_PROGRAM_ID = tenderProgramId;

/* -------------------------------------------------------------------------- */
/* Magic Action escrow funding                                                */
/* -------------------------------------------------------------------------- */

/**
 * Default lamports topped up into a wallet's MagicBlock escrow on first PER
 * interaction. The escrow pays for post-commit Magic Action base-layer fees
 * (e.g. our `withdraw_bid_finalize` close + bid_count decrement).
 *
 * 0.01 SOL = 10_000_000 lamports - enough for ~2000 actions at ~5000 lamports
 * each. Empirically tiny but generous; can refund the rest by closing escrow.
 */
export const DEFAULT_ESCROW_TOPUP_LAMPORTS = 10_000_000;

/**
 * Derive the MagicBlock escrow PDA for a given wallet authority + index.
 *
 * Hand-rolled because @magicblock-labs/ephemeral-rollups-kit@0.12.0 has a bug:
 * its `escrowPdaFromEscrowAuthority` derives under the escrow AUTHORITY's
 * address as the program - but the on-chain delegation program (and the
 * web3.js SDK) derive under `DELEGATION_PROGRAM_ID`. The kit helper produces
 * a different address than the topup ix expects, leading to `InvalidSeeds`
 * errors. Track upstream fix; remove this hand-roll when kit is patched.
 *
 * Seeds: `["balance", escrowAuthority, [index]]` under DELEGATION_PROGRAM_ID.
 */
const balanceSeed = new Uint8Array([98, 97, 108, 97, 110, 99, 101]); // "balance"

async function deriveEscrowPda(escrowAuthority: Address, index = 255): Promise<Address> {
  if (index < 0 || index > 255) throw new Error('escrow index must be 0..=255');
  const enc = getAddressEncoder();
  const [escrow] = await getProgramDerivedAddress({
    programAddress: DELEGATION_PROGRAM_ID,
    seeds: [balanceSeed, enc.encode(escrowAuthority), new Uint8Array([index])],
  });
  return escrow;
}

/**
 * Build the topup-escrow ix to pre-fund a wallet's MagicBlock escrow.
 * Include this in the same base-layer tx that does `delegate_bid` so the
 * escrow is funded before any Magic Action it scheduled needs to run.
 *
 * Idempotent on the lamports balance side - if the escrow is already funded,
 * the topup just adds more (small waste, but reliable).
 */
export async function buildEscrowTopupIx(
  walletAddress: Address,
  amountLamports: number = DEFAULT_ESCROW_TOPUP_LAMPORTS,
) {
  const escrow = await deriveEscrowPda(walletAddress);
  return createTopUpEscrowInstruction(escrow, walletAddress, walletAddress, amountLamports);
}
