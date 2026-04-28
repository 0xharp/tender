'use client';

import { useSelectedWalletAccount } from '@solana/react';
import { type UiWallet, useConnect, useDisconnect, useWallets } from '@wallet-standard/react';

import { Button } from '@/components/ui/button';

function shortAddress(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function WalletRow({ wallet }: { wallet: UiWallet }) {
  const [isConnecting, connect] = useConnect(wallet);
  const [, setSelectedAccount] = useSelectedWalletAccount();

  return (
    <Button
      variant="outline"
      disabled={isConnecting}
      onClick={async () => {
        const accounts = await connect();
        if (accounts[0]) {
          setSelectedAccount(accounts[0]);
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
  const wallets = useWallets();
  const [selected, , filtered] = useSelectedWalletAccount();

  const solanaCapableWallets = filtered ?? wallets;

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
  const [, setSelected] = useSelectedWalletAccount();
  const wallet = useWallets().find((w) => w.accounts.some((a) => a.address === address));
  const [, disconnect] = useDisconnect(wallet ?? ({} as UiWallet));

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
          setSelected(undefined);
        }}
      >
        Disconnect
      </Button>
    </div>
  );
}
