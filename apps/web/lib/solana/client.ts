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
 * SEPARATE mainnet RPC for SNS reads.
 *
 * The Tender program lives on devnet, but SNS data lives on MAINNET ONLY —
 * the SNS program is not deployed to devnet, so a devnet RPC will never
 * return SNS records even for wallets that own + have set primary `.sol`
 * names. Routing SNS calls through a mainnet RPC fixes this without
 * disrupting any other read path.
 *
 * Default = public mainnet endpoint (rate-limited but free; SNS reads are
 * cached in sessionStorage so we hit it sparingly). Override via
 * NEXT_PUBLIC_SNS_RPC_URL if you have a paid mainnet RPC handy.
 */
const SNS_RPC_HTTP =
  process.env.NEXT_PUBLIC_SNS_RPC_URL && process.env.NEXT_PUBLIC_SNS_RPC_URL.length > 0
    ? process.env.NEXT_PUBLIC_SNS_RPC_URL
    : 'https://api.mainnet-beta.solana.com';

export const snsRpc = createSolanaRpc(SNS_RPC_HTTP);
