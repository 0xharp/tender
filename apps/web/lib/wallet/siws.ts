/**
 * Sign-In With Solana — Tendr's SIWS implementation.
 *
 * Why this lives in lib/wallet/ and not in the SignInButton component:
 *
 *   1. The flow is two layers — building the canonical SIWS message,
 *      signing it with the wallet, posting to /api/auth/siws. That's
 *      orchestration logic; the button is just a UI surface.
 *
 *   2. Other surfaces may need to call sign-in programmatically in the
 *      future (e.g., re-auth after session expiry, deep-link landing).
 *      Centralizing here keeps SignInButton thin.
 *
 *   3. The wallet-side API choice (skip native `useSignIn`, use
 *      `signMessage` with manually-built SIWS text) is a Tendr-wide
 *      decision — see the WHY block below. The button shouldn't carry
 *      that reasoning in its file.
 *
 * WHY signMessage instead of useSignIn:
 *
 *   `solana:signIn` is the wallet-standard feature that powers Phantom's
 *   branded SIWS modal. Phantom + Backpack + Solflare implement it.
 *   Jupiter, Nightly, and several other wallets do NOT — `useSignIn`
 *   throws WalletStandardError #6160001 at hook init for those.
 *
 *   Workaround: build the canonical SIWS message text ourselves via
 *   `createSignInMessage` from @solana/wallet-standard-util (the SAME
 *   helper the server uses to verify), and sign those bytes via the
 *   universally-supported `solana:signMessage` feature. The server's
 *   verifySignIn doesn't care which wallet feature produced the
 *   signature — it just inspects the message format + key.
 *
 *   UX trade-off: Phantom users see a generic "sign this message" prompt
 *   showing the SIWS text instead of the branded modal. Acceptable to
 *   unblock every other wallet.
 */

'use client';

import {
  createSignInMessage,
  type SolanaSignInInputWithRequiredFields,
} from '@solana/wallet-standard-util';
import type { UiWalletAccount } from '@wallet-standard/react';

import { TENDR_CHAIN } from './chain';
import { type SignMessageFn } from './sign';

// Phantom is strict about SIWS message rendering: keep the statement plain
// ASCII (no em-dash, no fancy punctuation) and short. See:
// https://docs.phantom.app/solana/sign-in-with-solana
const STATEMENT =
  'Sign in to tendr.bid. This authorizes a 24-hour session. No funds will move.';

/** API contract with /api/auth/siws POST. Server reconstructs the SIWS
 *  message text from `input` and verifies it matches `output.signedMessage`,
 *  then verifies the signature against `output.account.publicKey`. */
interface SignInRequestBody {
  input: SolanaSignInInputWithRequiredFields;
  output: {
    account: { address: string; publicKey: string };
    signedMessage: string; // base64
    signature: string; // base64
  };
}

function bytesToBase64(input: ArrayLike<number>): string {
  let binary = '';
  for (let i = 0; i < input.length; i++) {
    binary += String.fromCharCode(input[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Build the SIWS input + sign it + POST to /api/auth/siws.
 *
 * Returns the wallet address that just authenticated (read from the
 * server's response, not the local input — the server is canonical).
 *
 * Throws on any failure (wallet rejected, signature verify failed, network
 * error). Caller is responsible for surfacing the error to the user.
 */
export async function performSiwsSignIn(args: {
  account: UiWalletAccount;
  signMessage: SignMessageFn;
}): Promise<{ wallet: string }> {
  const { account, signMessage } = args;
  const now = new Date();
  const expirationTime = new Date(now.getTime() + 5 * 60_000);

  const input: SolanaSignInInputWithRequiredFields = {
    address: account.address,
    domain: window.location.host,
    uri: window.location.origin,
    statement: STATEMENT,
    version: '1',
    chainId: TENDR_CHAIN,
    nonce: crypto.randomUUID().replace(/-/g, ''),
    issuedAt: now.toISOString(),
    expirationTime: expirationTime.toISOString(),
  };

  // Canonical SIWS message bytes — the same format any SIWS-native wallet
  // (Phantom, Backpack, Solflare) would have produced via `solana:signIn`.
  // The util's return is typed as ReadonlyUint8Array; we copy into a fresh
  // Uint8Array so it satisfies the wallet's signMessage signature + can be
  // base64-encoded the same way as the wallet's signature output.
  const signedMessage = new Uint8Array(createSignInMessage(input));
  const { signature } = await signMessage({ message: signedMessage });

  const body: SignInRequestBody = {
    input,
    output: {
      account: {
        address: account.address,
        publicKey: bytesToBase64(account.publicKey),
      },
      signedMessage: bytesToBase64(signedMessage),
      signature: bytesToBase64(signature),
    },
  };

  const res = await fetch('/api/auth/siws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `sign-in failed (${res.status})`);
  }

  return (await res.json()) as { wallet: string };
}

/** Server-side sign-out (clear session cookie). Called from the wallet
 *  popover and on account-change auto-disconnect. */
export async function performSignOut(): Promise<void> {
  await fetch('/api/auth/siws', { method: 'DELETE' });
}
