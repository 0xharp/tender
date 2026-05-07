/**
 * Tendr's wallet-standard chain identifier — used wherever we pass a chain
 * string to a wallet feature (`useSignTransactions`, `signAndSendTransaction`,
 * etc.). Centralizing here so:
 *
 *   1. There's exactly one place to flip when we move to mainnet.
 *   2. Components don't pepper the codebase with hardcoded `'solana:devnet'`
 *      literals that drift apart over time.
 *
 * The exported value is typed as the wallet-standard chain identifier so
 * mistypes ("solona:devnet") fail at compile time, not at wallet popup.
 */

import type { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains';

/** The wallet-standard chain string Tendr uses. Devnet today; will flip when
 *  we go to mainnet. Type-narrowed to the union of the two values we ever
 *  pass to wallet features. */
export type TendrChain = typeof SOLANA_DEVNET_CHAIN | typeof SOLANA_MAINNET_CHAIN;

export const TENDR_CHAIN: TendrChain = 'solana:devnet';
