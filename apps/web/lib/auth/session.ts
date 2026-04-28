/**
 * Session helpers — verify the SIWS-issued JWT from cookies.
 *
 * The JWT is signed with SUPABASE_JWT_SECRET so Supabase's RLS engine accepts
 * it as a valid auth context (`auth.jwt() ->> 'sub'` returns the wallet
 * address). Same JWT works on both our app's server side AND Supabase's
 * Postgres RLS layer.
 */
import { type JWTPayload, SignJWT, jwtVerify } from 'jose';

import { supabaseJwtSecret } from '@/lib/supabase/env';

export const SESSION_COOKIE_NAME = 'tender-session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24h
const ISSUER = 'tender';
const AUDIENCE = 'authenticated';

export interface TenderJwtPayload extends JWTPayload {
  sub: string; // wallet address
  role: 'authenticated';
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  iat: number;
  exp: number;
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(supabaseJwtSecret());
}

/** Mint a Supabase-compatible JWT for a wallet address. */
export async function mintSessionJwt(walletAddress: string): Promise<string> {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(walletAddress)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

/** Verify a session JWT; throws if invalid. Returns the decoded payload. */
export async function verifySessionJwt(jwt: string): Promise<TenderJwtPayload> {
  const { payload } = await jwtVerify(jwt, secretKey(), {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== 'string') {
    throw new Error('JWT missing sub');
  }
  return payload as TenderJwtPayload;
}

/** Server-only: read + verify the session cookie, return wallet or null. */
export async function getCurrentWallet(): Promise<string | null> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const jwt = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!jwt) return null;
  try {
    const payload = await verifySessionJwt(jwt);
    return payload.sub;
  } catch {
    return null;
  }
}
