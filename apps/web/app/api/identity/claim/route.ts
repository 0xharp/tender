/**
 * Mint a `<handle>.tendr.sol` subdomain on devnet for the authenticated
 * wallet.
 *
 *   POST /api/identity/claim
 *     body: { handle: string }
 *     auth: SIWS session cookie required
 *     200: { fullName, txSignature, subdomainPubkey }
 *     400: invalid handle (lexical / reserved)
 *     401: not signed in
 *     409: handle already taken on chain (or wallet already claimed)
 *     500: mint failure
 *
 * The mint is paid for + signed by Tender's parent-owner keypair (via
 * `lib/sns/devnet/mint.ts`). The user does NOT need to sign anything —
 * after this returns 200, `useSnsName(wallet)` will start resolving
 * `<handle>.tendr.sol` for the user's wallet (after cache TTL or refresh).
 */
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { mintTendrSubdomain } from '@/lib/sns/devnet/mint';
import { isTendrHandleTaken, resolveTendrSubdomain } from '@/lib/sns/devnet/resolve';
import { validateHandle } from '@/lib/sns/devnet/handle-validation';
import { snsRpc } from '@/lib/solana/client';

interface ClaimBody {
  handle?: string;
}

export async function POST(req: NextRequest) {
  const wallet = await getCurrentWallet();
  if (!wallet) {
    return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  }

  let body: ClaimBody;
  try {
    body = (await req.json()) as ClaimBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Lexical + reserved-blocklist validation.
  const validated = validateHandle(body.handle ?? '');
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400 });
  }
  const handle = validated.normalized;

  // Pre-check: does this wallet already have a tendr subdomain? Refuse to
  // mint a second one — tendr identity is one-per-wallet (user can rename
  // later via a separate burn-then-claim flow we'll build if needed).
  // biome-ignore lint/suspicious/noExplicitAny: snsRpc / Address branding nominal cast
  const existing = await resolveTendrSubdomain(snsRpc, wallet as any);
  if (existing) {
    return NextResponse.json(
      { error: `wallet already owns ${existing.name}`, existing: existing.name },
      { status: 409 },
    );
  }

  // Pre-check: is the requested handle already taken? Cheap RPC lookup
  // before the much heavier mint tx.
  const taken = await isTendrHandleTaken(snsRpc, handle);
  if (taken) {
    return NextResponse.json({ error: 'handle taken' }, { status: 409 });
  }

  try {
    const result = await mintTendrSubdomain(handle, wallet);
    return NextResponse.json({
      ok: true,
      fullName: result.fullName,
      txSignature: result.txSignature,
      subdomainPubkey: result.subdomainPubkey,
    });
  } catch (e) {
    const msg = (e as Error).message;
    // The on-chain create instruction will fail with "already in use" if
    // someone else claimed the handle in the gap between our check + the
    // mint tx — surface as 409 so the client can prompt for a new pick.
    if (msg.includes('already in use') || msg.includes('account already')) {
      return NextResponse.json({ error: 'handle taken' }, { status: 409 });
    }
    console.error('[claim] mint failed:', msg);
    return NextResponse.json({ error: 'mint failed', detail: msg }, { status: 500 });
  }
}
