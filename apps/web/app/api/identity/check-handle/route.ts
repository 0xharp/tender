/**
 * Lightweight handle-availability check for the claim modal's debounced
 * input. Validates lexically + checks if the on-chain account exists at
 * the derived address. Does NOT require a session — the result is purely
 * about whether a handle is mintable, not about any user state.
 *
 *   GET /api/identity/check-handle?handle=xxx
 *     200: { ok: true, normalized, available: boolean }
 *     400: { ok: false, reason } — fails lexical / blocklist
 *
 * The 200 path always sets `ok: true`; `available` is true if + only if
 * the handle passes lexical validation AND no on-chain account exists
 * yet. Race-safe: someone could mint between this check and the actual
 * claim, so the POST claim route also handles `409 already in use`.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { isTendrHandleTaken } from '@/lib/sns/devnet/resolve';
import { validateHandle } from '@/lib/sns/devnet/handle-validation';
import { snsRpc } from '@/lib/solana/client';

export async function GET(req: NextRequest) {
  const handle = req.nextUrl.searchParams.get('handle') ?? '';
  const validated = validateHandle(handle);
  if (!validated.ok) {
    return NextResponse.json({ ok: false, reason: validated.reason }, { status: 400 });
  }
  const taken = await isTendrHandleTaken(snsRpc, validated.normalized);
  return NextResponse.json({
    ok: true,
    normalized: validated.normalized,
    available: !taken,
  });
}
