'use client';

import { SelectedWalletAccountContextProvider } from '@solana/react';
import { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains';
import type { UiWallet } from '@wallet-standard/react';
import type { ReactNode } from 'react';

import { ClientOnly } from '@/components/client-only';

const STORAGE_KEY = 'tender:selected-wallet-account';

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

/** Only show wallets that support Solana (mainnet or devnet). */
function filterWallets(wallet: UiWallet): boolean {
  if (!wallet?.chains) return false;
  return wallet.chains.some(
    (chain) => chain === SOLANA_DEVNET_CHAIN || chain === SOLANA_MAINNET_CHAIN,
  );
}

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <ClientOnly fallback={children}>
      <SelectedWalletAccountContextProvider filterWallets={filterWallets} stateSync={stateSync}>
        {children}
      </SelectedWalletAccountContextProvider>
    </ClientOnly>
  );
}
