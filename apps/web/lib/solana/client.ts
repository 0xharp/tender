import { type Address, address, createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';

const HELIUS_HTTP = process.env.NEXT_PUBLIC_HELIUS_RPC_URL;
const HELIUS_WSS = process.env.NEXT_PUBLIC_HELIUS_WSS_URL;
const PROGRAM_ID = process.env.NEXT_PUBLIC_TENDER_PROGRAM_ID;

if (!HELIUS_HTTP) {
  throw new Error('NEXT_PUBLIC_HELIUS_RPC_URL is required (see .env.example)');
}
if (!HELIUS_WSS) {
  throw new Error('NEXT_PUBLIC_HELIUS_WSS_URL is required (see .env.example)');
}
if (!PROGRAM_ID) {
  throw new Error('NEXT_PUBLIC_TENDER_PROGRAM_ID is required (see .env.example)');
}

export const rpc = createSolanaRpc(HELIUS_HTTP);
export const rpcSubscriptions = createSolanaRpcSubscriptions(HELIUS_WSS);
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
 * Default: same Helius devnet URL as the rest of the app (HELIUS_HTTP).
 * Override via NEXT_PUBLIC_SNS_RPC_URL if you want to route SNS reads
 * to a different devnet endpoint (e.g. a separate billing/observability
 * project to keep getProgramAccounts traffic isolated).
 */
const SNS_RPC_HTTP =
  process.env.NEXT_PUBLIC_SNS_RPC_URL && process.env.NEXT_PUBLIC_SNS_RPC_URL.length > 0
    ? process.env.NEXT_PUBLIC_SNS_RPC_URL
    : HELIUS_HTTP;

export const snsRpc = createSolanaRpc(SNS_RPC_HTTP);
