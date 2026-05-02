/**
 * SIWS sign-in + sign-out endpoint.
 *
 *   POST   - verify a SIWS message, mint session JWT, set httpOnly cookie
 *   DELETE - clear the session cookie
 */
import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features';
import { verifySignIn } from '@solana/wallet-standard-util';
import { type NextRequest, NextResponse } from 'next/server';

import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS, mintSessionJwt } from '@/lib/auth/session';

const MAX_AGE_SECONDS_AGO = 5 * 60;
const MAX_AGE_SECONDS_AHEAD = 60;

interface PostBody {
  input: SolanaSignInInput;
  output: {
    account: { address: string; publicKey: string };
    signedMessage: string; // base64
    signature: string; // base64
  };
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.input || !body.output?.account?.publicKey) {
    return NextResponse.json({ error: 'missing input or output.account' }, { status: 400 });
  }

  // Domain check - caller must claim our exact host.
  const expectedHost = req.headers.get('host')?.toLowerCase();
  if (!expectedHost || body.input.domain?.toLowerCase() !== expectedHost) {
    return NextResponse.json(
      { error: `domain mismatch: expected ${expectedHost}, got ${body.input.domain}` },
      { status: 401 },
    );
  }

  // Liveness check - prevent stale signatures from being replayed forever.
  const now = Date.now();
  if (body.input.issuedAt) {
    const issuedAt = Date.parse(body.input.issuedAt);
    if (Number.isNaN(issuedAt) || issuedAt < now - MAX_AGE_SECONDS_AGO * 1000) {
      return NextResponse.json({ error: 'sign-in message expired' }, { status: 401 });
    }
    if (issuedAt > now + MAX_AGE_SECONDS_AHEAD * 1000) {
      return NextResponse.json(
        { error: 'sign-in message issuedAt is in the future' },
        { status: 401 },
      );
    }
  }

  // Reconstruct the byte-level Output that verifySignIn expects.
  const reconstructedOutput: SolanaSignInOutput = {
    account: {
      address: body.output.account.address,
      publicKey: fromBase64(body.output.account.publicKey),
      // chains/features/label aren't checked by verifySignIn; cast through unknown.
      chains: [],
      features: [],
    } as unknown as SolanaSignInOutput['account'],
    signedMessage: fromBase64(body.output.signedMessage),
    signature: fromBase64(body.output.signature),
    signatureType: 'ed25519',
  };

  if (!verifySignIn(body.input, reconstructedOutput)) {
    return NextResponse.json({ error: 'signature verification failed' }, { status: 401 });
  }

  const wallet = body.output.account.address;
  const jwt = await mintSessionJwt(wallet);

  const res = NextResponse.json({ ok: true, wallet });
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: jwt,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return res;
}
