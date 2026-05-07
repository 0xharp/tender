/**
 * Tendr wallet provider — the React context tree that backs every
 * `lib/wallet/*` hook. Mounted near the root of the app (in app/layout.tsx)
 * before any component that calls a wallet hook.
 *
 * Today this wraps `@solana/react`'s `SelectedWalletAccountContextProvider`
 * with our own filterWallets + localStorage stateSync. Components don't
 * import `@solana/react` directly — they import {@link TendrWalletProvider}
 * from here, keeping the swap-out boundary clean for future migrations.
 */

'use client';

import { SelectedWalletAccountContextProvider } from '@solana/react';
import { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains';
import type { UiWallet } from '@wallet-standard/react';
import type { ReactNode } from 'react';

import { ClientOnly } from '@/components/client-only';

import { TendrAutoReconnect } from './auto-reconnect';

const STORAGE_KEY = 'tender:selected-wallet-account';

/** localStorage-backed stateSync for SelectedWalletAccountContextProvider —
 *  remembers the last-selected wallet across page reloads so users don't
 *  have to re-pick on every visit. SSR-safe (window guards). */
const stateSync = {
  getSelectedWallet: () => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(STORAGE_KEY);
  },
  storeSelectedWallet: (accountKey: string) => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, accountKey);
  },
  deleteSelectedWallet: () => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(STORAGE_KEY);
  },
};

/** Filter to Solana-capable wallets only. Same filter as discovery.ts uses
 *  for the picker — mirrored here because the SelectedWalletAccount provider
 *  takes its own filter at mount time. */
function filterWallets(wallet: UiWallet): boolean {
  if (!wallet?.chains) return false;
  return wallet.chains.some(
    (chain) => chain === SOLANA_DEVNET_CHAIN || chain === SOLANA_MAINNET_CHAIN,
  );
}

export function TendrWalletProvider({ children }: { children: ReactNode }) {
  return (
    <ClientOnly fallback={children}>
      <SelectedWalletAccountContextProvider filterWallets={filterWallets} stateSync={stateSync}>
        {/* Silently re-authorizes the previously-selected wallet on mount,
            so wallets that don't auto-emit accounts on registration (e.g.
            Nightly) still hydrate `useTendrAccount()` to match the SIWS
            cookie. Without this, the navbar shows the user as signed in
            but action gates ("Connect a wallet to create an RFP") fail
            because the client account is missing. */}
        <TendrAutoReconnect />
        {children}
      </SelectedWalletAccountContextProvider>
    </ClientOnly>
  );
}
