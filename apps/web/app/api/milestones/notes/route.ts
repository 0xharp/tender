/**
 * Milestone notes API (off-chain context for milestone state transitions).
 *
 *   POST  - attach a note to a milestone. SIWS required; author_wallet is
 *           taken from the JWT (no spoofing). Idempotent at the table level
 *           via no-uniqueness — multiple notes per milestone are expected.
 *
 * GET is intentionally NOT exposed here; reads happen server-side via
 * `listMilestoneNotes` from the RFP detail page (cuts a network round-trip
 * and keeps the public-read RLS policy from being abused as a bulk scrape).
 */
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { milestoneNotePostSchema } from '@/lib/milestones/notes';
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

  const parsed = milestoneNotePostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('milestone_notes')
    .insert({
      rfp_pda: payload.rfp_pda,
      milestone_index: payload.milestone_index,
      author_wallet: wallet,
      kind: payload.kind,
      body: payload.body,
      tx_signature: payload.tx_signature ?? null,
    })
    .select('id, created_at')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, note: data });
}
