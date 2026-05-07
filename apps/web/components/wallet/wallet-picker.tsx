'use client';

/**
 * Wallet picker — list installed Solana wallets, click to connect, show
 * the connected account with a Disconnect button. All wallet-standard
 * plumbing flows through `@/lib/wallet/*`; this component is presentation.
 */

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  type TendrWallet,
  performSignOut,
  useTendrConnect,
  useTendrDisconnect,
  useTendrSelectedAccount,
  useTendrWallets,
} from '@/lib/wallet';

function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function WalletRow({ wallet }: { wallet: TendrWallet }) {
  const [isConnecting, connect] = useTendrConnect(wallet);
  const { setAccount } = useTendrSelectedAccount();

  return (
    <Button
      variant="outline"
      disabled={isConnecting}
      onClick={async () => {
        const accounts = await connect();
        if (accounts[0]) {
          setAccount(accounts[0]);
        }
      }}
      className="w-full justify-start gap-3"
    >
      {wallet.icon ? (
        <img src={wallet.icon} alt="" className="size-5 rounded" />
      ) : (
        <span className="size-5 rounded bg-muted" />
      )}
      <span>{wallet.name}</span>
      {isConnecting && <span className="ml-auto text-xs text-muted-foreground">connecting…</span>}
    </Button>
  );
}

export function WalletPicker() {
  // `wallets` is the unfiltered list (all wallet-standard wallets the
  // browser knows about); `filteredWallets` is the Solana-capable subset
  // the provider exposes. Prefer the filtered list when available so EVM-
  // only wallets don't appear as options.
  const wallets = useTendrWallets();
  const { account: selected, filteredWallets } = useTendrSelectedAccount();
  const solanaCapableWallets = filteredWallets.length > 0 ? filteredWallets : wallets;

  if (selected) {
    const wallet = wallets.find((w) => w.accounts.some((a) => a.address === selected.address));
    return <ConnectedAccount walletName={wallet?.name ?? 'Wallet'} address={selected.address} />;
  }

  if (solanaCapableWallets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No Solana wallets detected. Install Phantom, Backpack, or Solflare.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">Select wallet</p>
      {solanaCapableWallets.map((w) => (
        <WalletRow key={`${w.name}-${w.version}`} wallet={w} />
      ))}
    </div>
  );
}

function ConnectedAccount({ walletName, address }: { walletName: string; address: string }) {
  const router = useRouter();
  const { setAccount } = useTendrSelectedAccount();
  const wallets = useTendrWallets();
  const wallet = wallets.find((w) => w.accounts.some((a) => a.address === address));
  // useTendrDisconnect requires a wallet; fall back to a stub when the
  // wallet has been deregistered out from under us (rare — usually means
  // the user uninstalled the extension while connected).
  const [, disconnect] = useTendrDisconnect(wallet ?? ({} as TendrWallet));

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-3">
        <span className="size-2 rounded-full bg-green-500" />
        <div className="flex flex-col">
          <span className="font-medium">{walletName}</span>
          <span className="font-mono text-xs text-muted-foreground">{shortAddress(address)}</span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={async () => {
          if (wallet) await disconnect();
          setAccount(undefined);
          // Explicit disconnect → kill the SIWS cookie too. (WalletSessionSync
          // no longer handles this implicitly, since transient null states
          // during reconnect were causing spurious sign-outs.)
          await performSignOut();
          router.refresh();
        }}
      >
        Disconnect
      </Button>
    </div>
  );
}
