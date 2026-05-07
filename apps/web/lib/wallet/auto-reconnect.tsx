/**
 * Silent-reconnect for the previously-selected wallet on page load.
 *
 * Why: the upstream `SelectedWalletAccountContextProvider` restores the
 * saved wallet account by looking it up in `wallet.accounts`. But for
 * wallets that don't auto-emit accounts on registration (Nightly is the
 * canonical offender — Phantom and Backpack do auto-emit), `wallet.accounts`
 * is empty on a fresh page load, restore returns undefined, and the React
 * tree thinks no wallet is connected — even when the SIWS cookie is alive
 * and the navbar has already painted the user's handle.
 *
 * What this does: on mount, if localStorage has a saved wallet selection,
 * find that wallet in the registry and call its `standard:connect` feature
 * with `silent: true`. Most wallets honor silent mode by re-emitting the
 * previously-authorized accounts without a popup. Once accounts populate,
 * the upstream provider's auto-restore effect picks them up automatically.
 *
 * Fires once per page load per wallet (deduped via a Set ref). Failures
 * are swallowed — silent reconnect is a UX nicety, not load-bearing. If
 * the wallet refuses silent mode, the user just sees the explicit
 * "Connect wallet" path as before.
 */

'use client';

import { useEffect, useRef } from 'react';
import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains';
import { getWalletFeature, useWallets } from '@wallet-standard/react';

/** wallet-standard feature key for the connect feature. Hardcoded to the
 *  spec literal so we don't pull `@wallet-standard/features` as a direct
 *  dep just for one constant. */
const STANDARD_CONNECT_FEATURE = 'standard:connect' as const;

const STORAGE_KEY = 'tender:selected-wallet-account';

function readSavedWalletName(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return null;
    // Format is `${walletName}:${accountAddress}` per @wallet-standard/react's
    // getUiWalletAccountStorageKey. Split on first colon only — wallet names
    // shouldn't contain colons, but addresses won't either, so simple split is fine.
    const idx = v.indexOf(':');
    if (idx <= 0) return null;
    return v.slice(0, idx);
  } catch {
    return null;
  }
}

/**
 * Renders nothing. Mount inside `TendrWalletProvider`. Watches for the
 * previously-selected wallet to register, then silently reconnects to it.
 */
export function TendrAutoReconnect() {
  const wallets = useWallets();
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    const savedName = readSavedWalletName();
    if (!savedName) return;
    if (attempted.current.has(savedName)) return;

    const wallet = wallets.find((w) => w.name === savedName);
    if (!wallet) return; // not registered yet — re-runs when `wallets` updates

    // Already has accounts (auto-emitting wallet, or already reconnected) — done.
    if (wallet.accounts.length > 0) {
      attempted.current.add(savedName);
      return;
    }

    // Skip non-Solana wallets defensively (shouldn't ever match given the
    // saved key came from a Solana wallet originally, but be safe).
    const isSolana = wallet.chains?.some(
      (c) => c === SOLANA_DEVNET_CHAIN || c === SOLANA_MAINNET_CHAIN,
    );
    if (!isSolana) return;

    attempted.current.add(savedName);

    // Call the underlying standard:connect feature directly with silent: true.
    // The `useConnect` hook from @wallet-standard/react strips `silent` from
    // its type signature, so we go through getWalletFeature instead.
    try {
      const connectFeature = getWalletFeature(wallet, STANDARD_CONNECT_FEATURE) as {
        connect: (input?: { silent?: boolean }) => Promise<unknown>;
      };
      void connectFeature.connect({ silent: true }).catch(() => {
        // Wallet refused silent mode (or no prior authorization). User will
        // see the explicit "Connect wallet" path. Nothing to do here.
      });
    } catch {
      // Wallet doesn't expose standard:connect (very rare); skip.
    }
  }, [wallets]);

  return null;
}
