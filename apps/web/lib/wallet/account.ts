/**
 * Wallet-account hook — Tendr's single source of truth for "the connected
 * wallet account, if any." Components import from here, never from
 * `@solana/react` directly. That gives us:
 *
 *   - One swap point if/when we migrate the underlying wallet library.
 *   - One enforcement point for any cross-cutting checks we want to apply
 *     (e.g. SIWS gate, account-change detection) without touching consumers.
 *
 * Two hooks:
 *
 *   useTendrAccount()         — for the common case: "give me the connected
 *                                account or undefined." Used by every
 *                                component that just needs to know whether
 *                                a wallet is connected.
 *
 *   useTendrSelectedAccount() — for the wallet picker: returns the account
 *                                AND a setter (to mark a freshly-connected
 *                                account as selected) AND the filtered list
 *                                of Solana-capable wallets the underlying
 *                                provider knows about.
 */

'use client';

import { useSelectedWalletAccount as useSelectedWalletAccountUpstream } from '@solana/react';
import type { UiWallet, UiWalletAccount } from '@wallet-standard/react';

/** Returns the currently-selected wallet account, or `undefined` if no
 *  wallet is connected. The everyday hook — use this whenever the component
 *  only needs to read the connected account. */
export function useTendrAccount(): UiWalletAccount | undefined {
  const [account] = useSelectedWalletAccountUpstream();
  return account ?? undefined;
}

/** Returns full selection state — getter + setter + the filtered list of
 *  Solana-capable wallets. Used by the wallet picker which needs to mark
 *  freshly-connected accounts as selected, and to enumerate which wallets
 *  to render as options. */
export function useTendrSelectedAccount(): {
  account: UiWalletAccount | undefined;
  setAccount: (account: UiWalletAccount | undefined) => void;
  filteredWallets: readonly UiWallet[];
} {
  const [account, setAccount, filteredWallets] = useSelectedWalletAccountUpstream();
  return {
    account: account ?? undefined,
    setAccount,
    filteredWallets: filteredWallets ?? [],
  };
}

/** Re-export the wallet-account type so consumers don't pull from
 *  @wallet-standard/react directly. Anywhere a Tendr component needs to
 *  type a `UiWalletAccount` (props, function args), import this. */
export type { UiWalletAccount as TendrAccount } from '@wallet-standard/react';
