/**
 * Off-chain milestone notes — schema + write helper, safe for browser code.
 *
 * The READ side lives in `notes-server.ts` because it imports
 * `serverSupabase` (which depends on `next/headers` and breaks if pulled
 * into a client bundle). Keep these two files separate so a 'use client'
 * component importing `postMilestoneNote` doesn't accidentally pull the
 * server-only Supabase client.
 */
import { z } from 'zod';

import type { MilestoneNoteKind } from '@tender/shared';

export const milestoneNoteKindEnum: [MilestoneNoteKind, ...MilestoneNoteKind[]] = [
  'submit',
  'request_changes',
  'reject',
  'accept',
  'dispute_propose',
  'comment',
];

export const milestoneNotePostSchema = z.object({
  rfp_pda: z.string().min(32).max(44),
  milestone_index: z.number().int().min(0).max(7),
  kind: z.enum(milestoneNoteKindEnum),
  body: z.string().min(1).max(2000),
  /** Optional Solana tx signature - only set when the note attaches to a
   *  specific on-chain action (typically the case). */
  tx_signature: z.string().min(1).max(128).nullable().optional(),
});

export type MilestoneNotePostPayload = z.infer<typeof milestoneNotePostSchema>;

/**
 * Post a note from the browser. Optional - the on-chain action proceeds
 * either way, the note is attached as best-effort metadata. Failures here
 * surface as toasts but do NOT block the user's flow.
 */
export async function postMilestoneNote(
  payload: MilestoneNotePostPayload,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/milestones/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: j.error ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' };
  }
}
