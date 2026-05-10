/**
 * @/lib/wallet — Tendr's wallet integration boundary.
 *
 * Every consumer that needs a wallet hook, a wallet account type, or a
 * chain literal MUST import from here (or from a sub-path of this
 * directory). NEVER import from `@solana/react` or
 * `@wallet-standard/react` directly — that breaks the swap-out boundary.
 *
 * What's exposed:
 *
 *   Constants
 *     TENDR_CHAIN     — the wallet-standard chain identifier ('solana:devnet' today)
 *     TendrChain      — the type narrowed to mainnet|devnet
 *
 *   Account access
 *     useTendrAccount  — returns the connected wallet account (or undefined)
 *     TendrAccount     — type alias for the wallet account
 *
 *   Signing
 *     useTendrSignMessage      — sign raw bytes (SIWS, ECIES key derivation, etc.)
 *     useTendrSignTransactions — sign one or more txs in a single popup
 *     SignMessageFn / SignTransactionsFn / SignedTransaction — types
 *
 *   Discovery + connect
 *     useTendrWallets    — list of Solana-capable wallets the user has installed
 *     useTendrConnect    — connect a specific wallet
 *     useTendrDisconnect — disconnect a specific wallet
 *     TendrWallet        — type alias
 *
 *   SIWS sign-in
 *     performSiwsSignIn  — build SIWS message + sign + POST to /api/auth/siws
 *     performSignOut     — DELETE the session cookie server-side
 *
 *   Provider
 *     TendrWalletProvider — mount near the root, wraps children in the
 *                           wallet-standard context. See lib/wallet/provider.tsx.
 */

export { TENDR_CHAIN, type TendrChain } from './chain';
export { useTendrAccount, useTendrSelectedAccount, type TendrAccount } from './account';
export {
  useTendrSignMessage,
  useTendrSignTransactions,
  buildCloakSignTransactionAdapter,
  type SignMessageFn,
  type SignTransactionsFn,
  type SignedTransaction,
} from './sign';
export {
  useTendrWallets,
  useTendrConnect,
  useTendrDisconnect,
  type TendrWallet,
} from './discovery';
export { performSiwsSignIn, performSignOut } from './siws';
export { TendrWalletProvider } from './provider';
export { useKeychain, clearKeychainSeed, type KeychainHandle } from './use-keychain';
export { KeychainProvider, useKeychainContext } from './keychain-provider';
export {
  MyActivityProvider,
  clearMyActivityCache,
  triggerActivityRefresh,
  useMyActivity,
  type MyActivity,
  type MyOwnedRfp,
  type MyOwnBid,
  type MyEphemeral,
} from './my-activity-provider';
