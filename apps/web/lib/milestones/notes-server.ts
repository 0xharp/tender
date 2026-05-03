/**
 * Server-only read helper for milestone notes. Split from `notes.ts` so a
 * 'use client' component importing `postMilestoneNote` can't accidentally
 * pull `serverSupabase` (which depends on `next/headers` and would crash
 * the bundler).
 */
import 'server-only';

import type { MilestoneNoteRow } from '@tender/shared';

import { serverSupabase } from '@/lib/supabase/server';

/**
 * List notes for a single RFP, oldest-first. Used to render the per-milestone
 * thread in the RFP detail page.
 */
export async function listMilestoneNotes(rfpPda: string): Promise<MilestoneNoteRow[]> {
  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('milestone_notes')
    .select('id, rfp_pda, milestone_index, author_wallet, kind, body, tx_signature, created_at')
    .eq('rfp_pda', rfpPda)
    .order('created_at', { ascending: true });
  if (error) {
    // Log + return empty so a notes-table failure can't break the RFP page.
    console.error('[milestone_notes] list failed', error);
    return [];
  }
  return data ?? [];
}
