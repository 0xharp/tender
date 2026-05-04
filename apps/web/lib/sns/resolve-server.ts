/**
 * Server-side `.sol → pubkey` resolution helper for route segments that
 * take a `[wallet]` param (buyer profile, provider profile).
 *
 * Behavior: if the URL is already a base58 pubkey, no-op. If it's a
 * `.sol` name, resolve it on the server and return the pubkey — but
 * KEEP the `.sol` in the URL bar (don't redirect). Pages set a
 * `<link rel="canonical">` pointing at the pubkey URL via Next's
 * `metadata` export so search engines + analytics dedupe correctly.
 *
 * Why preserve `.sol` in the URL: more shareable, more readable,
 * matches Twitter/GitHub/X conventions where the username is the URL.
 * `.sol` ownership transfers are rare; when they do happen the URL
 * semantically still means "the wallet that currently owns this name"
 * — same model as Twitter handles.
 *
 * If the `.sol` doesn't resolve, redirect to the fallback path (404'ing
 * with a useful URL is better than crashing with a base58-codec error).
 */
import 'server-only';

import { redirect } from 'next/navigation';

import { resolveSnsToWallet } from './resolve';
import { resolveTendrSubdomain } from './devnet/resolve';
import { snsRpc } from '@/lib/solana/client';

/** Cheap heuristic — base58 pubkeys are 32-44 chars and contain no `.`. */
function looksLikeWallet(input: string): boolean {
  if (input.length < 32 || input.length > 44) return false;
  if (input.includes('.')) return false;
  return true;
}

/**
 * Returns the resolved wallet pubkey for a route param. URL is left
 * unchanged — caller renders the page with the resolved pubkey
 * internally but the browser address bar keeps the `.sol`.
 *
 * If the `.sol` doesn't resolve, REDIRECTS to the fallback path (the
 * page would crash trying to use an unresolvable string as a pubkey).
 */
export async function resolveWalletParam(
  param: string,
  fallback = '/',
): Promise<string> {
  if (looksLikeWallet(param)) return param;
  const resolved = await resolveSnsToWallet(snsRpc, param);
  if (!resolved) {
    redirect(fallback);
  }
  return resolved;
}

/**
 * Non-redirecting variant for non-page contexts (OG image route handlers,
 * background tasks). Returns null for an unresolvable `.sol` instead of
 * triggering a redirect - OG handlers must always render an image, not a
 * 307 to "/".
 */
export async function tryResolveWalletParam(param: string): Promise<string | null> {
  if (looksLikeWallet(param)) return param;
  try {
    return await resolveSnsToWallet(snsRpc, param);
  } catch {
    return null;
  }
}

/**
 * Server-side helper: resolve a wallet's tendr identity name (if any)
 * for use as a URL slug. Returns `<handle>.tendr.sol` when claimed,
 * otherwise the raw pubkey. Use this anywhere a server component builds
 * a /providers/ or /buyers/ link so the URL is human-readable.
 *
 * Null-safe — never throws. Failures fall back to the pubkey so the
 * link always works.
 */
export async function preferredProfileSlug(walletPubkey: string): Promise<string> {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: snsRpc and Address branding nominal cast
    const hit = await resolveTendrSubdomain(snsRpc, walletPubkey as any);
    return hit?.name ?? walletPubkey;
  } catch {
    return walletPubkey;
  }
}
