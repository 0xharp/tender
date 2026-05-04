import {
  getPrimaryDomain,
  getPrimaryDomainsBatch,
  resolveDomain,
} from '@solana-name-service/sns-sdk-kit';
/**
 * SNS (Solana Name Service) resolution helpers.
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
 * SNS mappings are public on chain. Resolution surfaces existing public
 * data; it does not create new public data. But if we resolved SNS for an
 * ephemeral bid signer, we'd be ASKING a public service "what's this
 * wallet's name" — even though the answer would be null today, that
 * pattern leaves a metadata trail (HTTP request to SNS RPC tied to the
 * ephemeral pubkey + viewer's IP) that erodes the privacy property.
 *
 * Enforcement is a code convention, not a runtime check. Don't pass
 * ephemeral wallets into these functions. The bid-composer flow has a
 * behavioral test asserting this invariant holds in the only place it
 * could practically break.
 *
 * ============================================================================
 */
import type {
  Address,
  GetAccountInfoApi,
  GetMultipleAccountsApi,
  GetTokenLargestAccountsApi,
  Rpc,
} from '@solana/kit';

/** Suffix .sol gets stripped/added by the SDK depending on call. We keep
 *  the suffix in everything we display to the user. */
const SOL_SUFFIX = '.sol';

/** Strip a leading `@` and a trailing `.sol` so we can normalize whatever
 *  the user types in. */
export function normalizeSnsInput(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('@')) s = s.slice(1);
  if (s.toLowerCase().endsWith(SOL_SUFFIX)) s = s.slice(0, -SOL_SUFFIX.length);
  return s;
}

/** Append `.sol` if not present. Used to render the canonical name. */
export function withSolSuffix(name: string): string {
  return name.toLowerCase().endsWith(SOL_SUFFIX) ? name : `${name}${SOL_SUFFIX}`;
}

/** RPC capability typings expected by every SNS read-only call we make. */
type SnsReadRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi & GetTokenLargestAccountsApi>;

/**
 * FORWARD: human-typed name → wallet address.
 *
 * Used by the bid-composer payout-destination input — provider types
 * "alice.sol", we resolve to the underlying wallet, validate, and store
 * the resolved pubkey in the bid envelope. Chain only ever sees pubkeys.
 *
 * Returns null if the name doesn't resolve (typo, doesn't exist, etc.)
 * rather than throwing — caller renders a "couldn't find that name"
 * message.
 */
export async function resolveSnsToWallet(
  rpc: SnsReadRpc,
  rawName: string,
): Promise<Address | null> {
  const name = normalizeSnsInput(rawName);
  if (name.length === 0) return null;
  try {
    return await resolveDomain({ rpc, domain: name });
  } catch {
    return null;
  }
}

/**
 * REVERSE: wallet → primary `.sol` (or null if none set).
 *
 * Used by HashLink + every wallet-display surface to render `alice.sol`
 * instead of `4xRC…dN3n`.
 *
 * "Primary" / "favorite" semantics: the wallet must have explicitly set
 * a domain as its primary. Many wallets own multiple .sol names but only
 * one is canonical at a time. The SDK also returns a `stale` flag — true
 * means the primary record was set under a previous owner of that domain
 * and we should treat the result as not-trusted. We return null in that
 * case (display falls back to the truncated hash).
 *
 * PRIVACY INVARIANT: only call for ALREADY-PUBLIC wallets. Don't pass
 * ephemeral bid signers. See top-of-file note.
 */
export async function resolveWalletToSns(rpc: SnsReadRpc, wallet: Address): Promise<string | null> {
  try {
    const result = await getPrimaryDomain({ rpc, walletAddress: wallet });
    if (result.stale) return null;
    return withSolSuffix(result.domainName);
  } catch {
    return null;
  }
}

/**
 * BULK REVERSE: many wallets → primary names in one batched RPC call.
 *
 * Use this for the leaderboard + any other surface listing N wallets at
 * once. Single getMultipleAccounts call per batch instead of N individual
 * round-trips. The SDK's batch returns an array of `string | undefined`
 * matching `walletAddresses` element-for-element; we normalize undefined
 * to null and append the .sol suffix.
 *
 * PRIVACY INVARIANT: only pass ALREADY-PUBLIC wallets. Don't bulk-resolve
 * a list that includes ephemeral bid signers.
 */
export async function resolveWalletsToSns(
  rpc: SnsReadRpc,
  wallets: Address[],
): Promise<Map<Address, string | null>> {
  const out = new Map<Address, string | null>();
  if (wallets.length === 0) return out;

  // Dedupe — caller may pass repeats; one fewer RPC slot consumed each.
  const unique = Array.from(new Set(wallets));
  try {
    const names = await getPrimaryDomainsBatch({ rpc, walletAddresses: unique });
    unique.forEach((wallet, i) => {
      const name = names[i];
      out.set(wallet, name ? withSolSuffix(name) : null);
    });
  } catch {
    // Whole-batch failure → render every wallet as null (truncated-hash
    // fallback). Don't throw — SNS is a UX nicety, not load-bearing.
    for (const w of unique) out.set(w, null);
  }
  return out;
}
