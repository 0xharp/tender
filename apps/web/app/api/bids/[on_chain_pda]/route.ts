/**
 * DELETE /api/bids/[on_chain_pda]
 *
 * Drops the off-chain bid_ciphertexts row after the provider has executed
 * withdraw_bid on-chain (which closes the BidCommit PDA + refunds rent).
 *
 * Authorization: caller must be signed in AND the row's provider_wallet must
 * match the JWT subject (RLS enforces this on the DELETE).
 *
 * Side effect: decrements rfps.bid_count via admin client (RLS only allows
 * the buyer to update rfps; the counter is a pure aggregate and should track
 * every ciphertext row).
 */
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { adminSupabase } from '@/lib/supabase/admin';
import { serverSupabase } from '@/lib/supabase/server';

interface RouteParams {
  params: Promise<{ on_chain_pda: string }>;
}

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const wallet = await getCurrentWallet();
  if (!wallet) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const { on_chain_pda } = await params;
  if (!on_chain_pda || on_chain_pda.length < 32) {
    return NextResponse.json({ error: 'invalid bid PDA' }, { status: 400 });
  }

  const supabase = await serverSupabase();

  // Look up first so we can decrement the right RFP's counter.
  const { data: existing, error: fetchErr } = await supabase
    .from('bid_ciphertexts')
    .select('rfp_id, provider_wallet')
    .eq('on_chain_pda', on_chain_pda)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }
  if (!existing) {
    return NextResponse.json({ error: 'bid not found' }, { status: 404 });
  }
  if (existing.provider_wallet !== wallet) {
    return NextResponse.json({ error: 'not your bid' }, { status: 403 });
  }

  // RLS allows DELETE when provider_wallet = jwt.sub.
  const { error: delErr } = await supabase
    .from('bid_ciphertexts')
    .delete()
    .eq('on_chain_pda', on_chain_pda);
  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  // Decrement counter (admin bypass — RLS only lets the buyer update rfps).
  const admin = adminSupabase();
  const { data: rfpRow } = await admin
    .from('rfps')
    .select('bid_count')
    .eq('id', existing.rfp_id)
    .single();
  if (rfpRow) {
    await admin
      .from('rfps')
      .update({ bid_count: Math.max(0, (rfpRow.bid_count ?? 0) - 1) })
      .eq('id', existing.rfp_id);
  }

  return NextResponse.json({ ok: true });
}
