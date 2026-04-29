'use client';

import { useSignIn } from '@solana/react';
import type { SolanaSignInInput } from '@solana/wallet-standard-features';
import type { UiWalletAccount } from '@wallet-standard/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

// Phantom is strict about SIWS message rendering: keep the statement plain
// ASCII (no em-dash, no fancy punctuation) and short. See:
// https://docs.phantom.app/solana/sign-in-with-solana
const STATEMENT = 'Sign in to Tender. This authorizes a 24-hour session. No funds will move.';

function bytesToBase64(input: { length: number; [n: number]: number }): string {
  let binary = '';
  for (let i = 0; i < input.length; i++) {
    binary += String.fromCharCode(input[i] ?? 0);
  }
  return btoa(binary);
}

export function SignInButton({
  account,
  onSignedIn,
}: {
  account: UiWalletAccount;
  onSignedIn?: (wallet: string) => void;
}) {
  const signIn = useSignIn(account);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const expirationTime = new Date(now.getTime() + 5 * 60_000);
      const input: Omit<SolanaSignInInput, 'address'> = {
        domain: window.location.host,
        uri: window.location.origin,
        statement: STATEMENT,
        version: '1',
        chainId: 'solana:devnet',
        nonce: crypto.randomUUID().replace(/-/g, ''),
        issuedAt: now.toISOString(),
        expirationTime: expirationTime.toISOString(),
      };

      const output = await signIn(input);

      const res = await fetch('/api/auth/siws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Server reconstructs `input` with the wallet's address.
          input: { ...input, address: output.account.address },
          output: {
            account: {
              address: output.account.address,
              publicKey: bytesToBase64(output.account.publicKey),
            },
            signedMessage: bytesToBase64(output.signedMessage),
            signature: bytesToBase64(output.signature),
          },
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `sign-in failed (${res.status})`);
      }

      const { wallet } = (await res.json()) as { wallet: string };
      onSignedIn?.(wallet);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={handleSignIn} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in with Solana'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
