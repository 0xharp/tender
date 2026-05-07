/**
 * Wallet discovery + connect/disconnect — wraps the wallet-standard
 * registry so components see Tendr-shaped APIs instead of raw library
 * exports.
 *
 * Used by the wallet picker to enumerate installed Solana wallets and
 * trigger their connect/disconnect flows. The underlying lib is
 * @wallet-standard/react today; consumers don't need to know.
 */

'use client';

import {
  type UiWallet,
  useConnect as useConnectUpstream,
  useDisconnect as useDisconnectUpstream,
  useWallets as useWalletsUpstream,
} from '@wallet-standard/react';

import { TENDR_CHAIN } from './chain';
import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
} from '@solana/wallet-standard-chains';

/** A wallet entry the picker can render. Mirrors the upstream shape so
 *  consumers can treat it as a Tendr type while we keep the library
 *  swappable. */
export type TendrWallet = UiWallet;

/**
 * Returns the list of Solana-capable wallets the user has installed.
 *
 * Filters out wallets that don't list Solana mainnet OR devnet in their
 * supported chains — keeps EVM-only wallets (e.g., MetaMask without the
 * Solana add-on) out of the picker.
 *
 * Note: we filter on EITHER mainnet or devnet so users on a wallet that
 * doesn't expose devnet chain (some configurations) can still appear and
 * sign — the actual chain we PASS to wallet features is {@link TENDR_CHAIN}
 * regardless.
 */
export function useTendrWallets(): readonly TendrWallet[] {
  const wallets = useWalletsUpstream();
  return wallets.filter((w) => {
    if (!w?.chains) return false;
    return w.chains.some(
      (chain) => chain === SOLANA_DEVNET_CHAIN || chain === SOLANA_MAINNET_CHAIN,
    );
  });
}

/** Hook that returns a function to connect to a specific wallet. */
export function useTendrConnect(wallet: TendrWallet) {
  return useConnectUpstream(wallet);
}

/** Hook that returns a function to disconnect from a specific wallet. */
export function useTendrDisconnect(wallet: TendrWallet) {
  return useDisconnectUpstream(wallet);
}

void TENDR_CHAIN;
