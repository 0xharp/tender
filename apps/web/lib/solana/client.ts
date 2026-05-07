import {
  type Address,
  address,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
import { createHttpTransportForSolanaRpc } from '@solana/rpc-transport-http';

// Provider-agnostic env names — works with any Solana RPC (RPC Fast, Helius,
// Triton, QuickNode, public RPC, your own validator) as long as it speaks
// standard JSON-RPC over HTTP + WSS.
const SOLANA_HTTP = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
const SOLANA_WSS = process.env.NEXT_PUBLIC_SOLANA_WSS_URL;
const PROGRAM_ID = process.env.NEXT_PUBLIC_TENDER_PROGRAM_ID;

if (!SOLANA_HTTP) {
  throw new Error('NEXT_PUBLIC_SOLANA_RPC_URL is required (see .env.example)');
}
if (!SOLANA_WSS) {
  throw new Error('NEXT_PUBLIC_SOLANA_WSS_URL is required (see .env.example)');
}
if (!PROGRAM_ID) {
  throw new Error('NEXT_PUBLIC_TENDER_PROGRAM_ID is required (see .env.example)');
}

/**
 * Build a Solana RPC client without the auto-injected `solana-client`
 * identifier header.
 *
 * Why: `@solana/kit`'s `createSolanaRpc` (via `createDefaultRpcTransport`)
 * unconditionally injects a `solana-client: js/<version>` header on every
 * request. Some RPC providers (RPC Fast observed) don't include
 * `solana-client` in their CORS `Access-Control-Allow-Headers` allowlist,
 * so the browser preflight rejects every call before it leaves the page.
 *
 * Going around `createDefaultRpcTransport` and assembling a transport
 * directly via `createHttpTransportForSolanaRpc` (which preserves the
 * Solana-specific bigint codec) skips the header injection entirely. The
 * one feature we lose vs. the default is in-flight request coalescing —
 * acceptable trade-off for working CORS, and we can re-add it later if
 * burst traffic becomes an issue (this is a hackathon-grade UI, not
 * a high-RPS reader).
 *
 * Same approach as the `x-stainless-*` workaround in `lib/ai/client.ts`
 * (OpenAI SDK injects telemetry headers QVAC's CORS doesn't allow).
 */
function buildPortableRpc(url: string) {
  const transport = createHttpTransportForSolanaRpc({ url });
  return createSolanaRpcFromTransport(transport);
}

export const rpc = buildPortableRpc(SOLANA_HTTP);
export const rpcSubscriptions = createSolanaRpcSubscriptions(SOLANA_WSS);
export const tenderProgramId: Address = address(PROGRAM_ID);

/**
 * RPC for SNS reads (now DEVNET, post tendr-subdomain switch).
 *
 * The tendr identity layer mints `<handle>.tendr.sol` subdomains on
 * devnet under our own parent domain (see `lib/sns/devnet/`). All SNS
 * resolution — both reverse-lookup (wallet → name) and forward-lookup
 * (name → wallet) — runs against the SAME devnet hierarchy where the
 * Tender program already lives. Mainnet `.sol` names are NOT resolved
 * here — that's intentional scope (SNS is now Tender-issued identity,
 * not a wrapper around any wallet's mainnet primary).
 *
 * Default: same RPC URL as the rest of the app (SOLANA_HTTP).
 * Override via NEXT_PUBLIC_SNS_RPC_URL if you want to route SNS reads
 * to a different devnet endpoint (e.g. a separate billing/observability
 * project to keep getProgramAccounts traffic isolated).
 */
const SNS_RPC_HTTP =
  process.env.NEXT_PUBLIC_SNS_RPC_URL && process.env.NEXT_PUBLIC_SNS_RPC_URL.length > 0
    ? process.env.NEXT_PUBLIC_SNS_RPC_URL
    : SOLANA_HTTP;

export const snsRpc = buildPortableRpc(SNS_RPC_HTTP);

/**
 * `fetchMiddleware` for `@solana/web3.js`'s `Connection` that strips the
 * auto-injected `solana-client` UA header before the request leaves the
 * page. Same root cause as the kit-side `buildPortableRpc()` workaround
 * above: web3.js merges `COMMON_HTTP_HEADERS = { 'solana-client': … }`
 * AFTER user-supplied `httpHeaders`, so the user can't override it via
 * config — the only intercept point is the `fetchMiddleware` hook, which
 * runs after web3.js builds the headers and before the `fetch()` call.
 *
 * RPC providers like RPC Fast don't include `solana-client` in their
 * CORS `Access-Control-Allow-Headers` allowlist, so the browser preflight
 * rejects every web3.js Connection RPC call. This affects the Cloak
 * funding + sweep flows, which both go through web3.js (Cloak's SDK
 * expects a web3.js `Connection`).
 *
 * Pass to `new Connection(url, { commitment, fetchMiddleware: stripSolanaClientHeaderMiddleware })`.
 *
 * Typed loosely (`unknown` / casted at the call site) so this file
 * doesn't have to pull `@solana/web3.js` types into the synchronous
 * client bundle — every consumer already imports web3.js dynamically.
 */
export function stripSolanaClientHeaderMiddleware(
  info: unknown,
  init: { headers?: Record<string, string> } | undefined,
  next: (info: unknown, init: unknown) => void,
): void {
  if (init?.headers) {
    const headers = { ...init.headers };
    delete headers['solana-client'];
    init = { ...init, headers };
  }
  next(info, init);
}
