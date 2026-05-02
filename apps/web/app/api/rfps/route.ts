/**
 * RFP metadata API.
 *
 * After the Day 6.5 supabase shrink + the milestone-removal pass, supabase
 * only stores the human-readable scope text we never put on-chain (title,
 * scope_summary). Milestones are entirely a bid-side concern now (they live
 * inside the encrypted bid envelope). Everything else (windows, status,
 * bid_count, winner, identity, visibility, category, milestone count once
 * awarded) lives on the on-chain Rfp account at `on_chain_pda`.
 *
 *   POST  - write metadata after the on-chain rfp_create tx confirms. Caller
 *           must be SIWS-signed (any wallet can pin metadata for an RFP they
 *           created on-chain - the on-chain account itself enforces buyer
 *           identity).
 *   GET   - list metadata rows. Clients enrich by reading on-chain Rfp
 *           accounts via `lib/solana/chain-reads.ts`.
 */
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { rfpCreatePayloadSchema } from '@/lib/rfps/schema';
import { serverSupabase } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const wallet = await getCurrentWallet();
  if (!wallet) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = rfpCreatePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .insert({
      on_chain_pda: payload.on_chain_pda,
      rfp_nonce_hex: payload.rfp_nonce_hex,
      title: payload.title,
      scope_summary: payload.scope_summary,
      tx_signature: payload.tx_signature,
    })
    .select('id, on_chain_pda')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rfp: data });
}

export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? '50'), 1), 100);

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .select('id, on_chain_pda, title, scope_summary, tx_signature, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Status filtering happens client-side after enriching with on-chain Rfp data.
  return NextResponse.json({ rfps: data });
}
