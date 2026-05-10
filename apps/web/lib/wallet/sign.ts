/**
 * Signing primitives — `useTendrSignMessage` + `useTendrSignTransactions`.
 *
 * Wraps `@solana/react`'s per-feature hooks behind Tendr-shaped names so
 * consumers don't need to know which underlying library is providing
 * signing today. The wrappers:
 *
 *   - Auto-pass {@link TENDR_CHAIN} to `useSignTransactions` so call sites
 *     don't repeat `'solana:devnet'` in 9+ places.
 *   - Provide a single error surface (`SignError`) callers can `instanceof`
 *     check, decoupled from whatever the upstream lib throws.
 *   - Live in one file so future changes (e.g., custom retry, telemetry,
 *     wrapping for a different wallet library) only touch this module.
 *
 * We deliberately don't re-export @solana/react's hooks directly — components
 * should always use `useTendrSign*`. That keeps the swap-out boundary clean.
 */

'use client';

import { useSignMessage, useSignTransactions } from '@solana/react';
import type { UiWalletAccount } from '@wallet-standard/react';

import { TENDR_CHAIN } from './chain';

/* -------------------------------------------------------------------------- */
/* Cloak adapter — bridge wallet-standard's batched signTransactions hook     */
/* into Cloak SDK's single-tx `signTransaction` shape. Same pattern as        */
/* bid-composer.tsx:920 — extracted here so every caller (bid-composer,      */
/* buyer-action-panel, future cloak-touching surfaces) uses one canonical    */
/* implementation that's wallet-standard-portable, not Phantom-specific.     */
/* -------------------------------------------------------------------------- */

/** Return type of useTendrSignMessage — function that signs raw bytes and
 *  returns the signature (also raw bytes). Stable shape across wallet libs. */
export type SignMessageFn = (input: { message: Uint8Array }) => Promise<{
  signedMessage: Uint8Array;
  signature: Uint8Array;
}>;

/**
 * Hook returning a function to sign raw message bytes via the connected
 * wallet's `solana:signMessage` feature. Used for ECIES key derivation,
 * SIWS message signing, ephemeral wallet derivation, TEE auth tokens —
 * any non-transaction signing.
 */
export function useTendrSignMessage(account: UiWalletAccount): SignMessageFn {
  // biome-ignore lint/suspicious/noExplicitAny: @solana/react's hook narrows via overloads that don't compose with our wrapper; re-narrowing here is structurally fine
  const upstream = useSignMessage(account) as any;
  return async ({ message }) => {
    const result = await upstream({ message });
    return {
      signedMessage: result.signedMessage as Uint8Array,
      signature: result.signature as Uint8Array,
    };
  };
}

/** Each transaction the wallet has signed, returned in submit order. */
export interface SignedTransaction {
  /** The signed bytes ready to dispatch to an RPC. */
  signedTransaction: Uint8Array;
}

/** Function returned by useTendrSignTransactions — takes one or more
 *  unsigned transactions, returns them signed (in the same order). */
export type SignTransactionsFn = (
  ...transactions: Array<{ transaction: Uint8Array }>
) => Promise<readonly SignedTransaction[]>;

/**
 * Hook returning a function to sign one OR MORE transactions in a single
 * wallet popup via the connected wallet's `solana:signTransaction` feature.
 * Critical for Tendr's bid-submit flow which signs ~12 transactions
 * (commit_bid_init + delegate_bid + N chunks + finalize_bid) in one shot.
 *
 * Auto-passes {@link TENDR_CHAIN} so call sites don't need to remember to.
 */
export function useTendrSignTransactions(account: UiWalletAccount): SignTransactionsFn {
  // biome-ignore lint/suspicious/noExplicitAny: same narrowing reason as above
  const upstream = useSignTransactions(account, TENDR_CHAIN) as any;
  return async (...transactions) => {
    const results = await upstream(...transactions);
    return (results as Array<{ signedTransaction: Uint8Array }>).map((r) => ({
      signedTransaction: r.signedTransaction,
    }));
  };
}

/**
 * Cloak SDK expects a single-tx signer of shape
 *   `<T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>`
 * (one Transaction in, the same Transaction with signatures attached out).
 *
 * The wallet-standard `signTransactions` feature instead works on raw bytes
 * (one batch popup that may contain many txs). To reuse our single
 * cross-wallet signing primitive for Cloak's single-tx contract, we
 * serialize → run the bytes through `signTransactions` → deserialize back
 * into the same Transaction shape.
 *
 * Why a factory rather than a hook: Cloak callers run inside event handlers
 * (`async function handleFund() { … }`), where you can't call hooks. Pass
 * the already-resolved `signTransactions` function in here once, and the
 * returned adapter closes over it for as many Cloak calls as you need.
 *
 * Wallet portability: this helper holds NO Phantom-specific assumptions —
 * it relies only on the wallet-standard `solana:signTransaction` feature,
 * which Phantom, Backpack, Solflare, Nightly, Glow, et al. all support.
 *
 * The dynamic web3.js import is shared with the Cloak chunk (~1.6MB), so
 * paying for it here doesn't add to the cold-start cost when the caller
 * is already loading Cloak.
 */
export async function buildCloakSignTransactionAdapter(
  signTransactions: SignTransactionsFn,
): Promise<
  <
    T extends
      | import('@solana/web3.js').Transaction
      | import('@solana/web3.js').VersionedTransaction,
  >(
    tx: T,
  ) => Promise<T>
> {
  const { Transaction, VersionedTransaction } = await import('@solana/web3.js');
  return async <
    T extends
      | import('@solana/web3.js').Transaction
      | import('@solana/web3.js').VersionedTransaction,
  >(
    tx: T,
  ): Promise<T> => {
    const isV0 = !(tx instanceof Transaction);
    const serialized = isV0
      ? (tx as import('@solana/web3.js').VersionedTransaction).serialize()
      : (tx as import('@solana/web3.js').Transaction).serialize({
          requireAllSignatures: false,
        });
    const [signed] = await signTransactions({ transaction: new Uint8Array(serialized) });
    if (!signed) throw new Error('signTransactions returned no outputs');
    if (isV0) {
      return VersionedTransaction.deserialize(signed.signedTransaction) as unknown as T;
    }
    return Transaction.from(signed.signedTransaction) as unknown as T;
  };
}
