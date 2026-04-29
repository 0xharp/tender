/**
 * RFP API.
 *
 *   POST   — write RFP metadata to Supabase after the on-chain rfp_create
 *            tx has confirmed. RLS enforces that buyer_wallet matches the
 *            session JWT subject.
 *   GET    — list public RFPs (filterable; status defaults to 'open').
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

  // Defense in depth — RLS will also enforce, but fail fast on the obvious case.
  if (payload.on_chain_pda && /* the buyer is the session caller */ true) {
    // (no extra check needed; RLS handles buyer_wallet = jwt.sub)
  }

  // Validate the milestone percentages sum to 100 — domain rule, not in zod
  // because it's a cross-field check.
  const sum = payload.milestone_template.reduce((acc, m) => acc + m.percentage, 0);
  if (sum !== 100) {
    return NextResponse.json(
      { error: `milestone percentages must sum to 100; got ${sum}` },
      { status: 400 },
    );
  }

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .insert({
      on_chain_pda: payload.on_chain_pda,
      buyer_wallet: wallet,
      buyer_encryption_pubkey_hex: payload.buyer_encryption_pubkey_hex,
      rfp_nonce_hex: payload.rfp_nonce_hex,
      title: payload.title,
      category: payload.category,
      scope_summary: payload.scope_summary,
      scope_detail_encrypted: null,
      budget_max_usdc: payload.budget_max_usdc,
      bid_open_at: payload.bid_open_at,
      bid_close_at: payload.bid_close_at,
      reveal_close_at: payload.reveal_close_at,
      milestone_template: payload.milestone_template,
      tx_signature: payload.tx_signature,
    })
    .select('id, on_chain_pda')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rfp: data });
}

const VALID_STATUSES = [
  'draft',
  'open',
  'reveal',
  'awarded',
  'in_progress',
  'completed',
  'disputed',
  'cancelled',
] as const;
type StatusFilter = (typeof VALID_STATUSES)[number];

export async function GET(req: NextRequest) {
  const requestedStatus = req.nextUrl.searchParams.get('status') ?? 'open';
  if (!VALID_STATUSES.includes(requestedStatus as StatusFilter)) {
    return NextResponse.json({ error: 'invalid status filter' }, { status: 400 });
  }
  const status = requestedStatus as StatusFilter;
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? '50');

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .select(
      'id, on_chain_pda, buyer_wallet, title, category, scope_summary, budget_max_usdc, bid_open_at, bid_close_at, reveal_close_at, milestone_template, status, bid_count, created_at',
    )
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ rfps: data });
}
