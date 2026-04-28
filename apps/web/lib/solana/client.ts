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
