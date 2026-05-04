'use client';

/**
 * Per-milestone notes thread - read-only display of off-chain notes attached
 * to milestone state transitions. Sits at the bottom of each milestone row
 * in both buyer + provider action panels.
 *
 * Posting happens inline in the submit/request_changes button handlers, NOT
 * here - this component only renders. That keeps the thread component dumb
 * + reusable from any role context.
 */
import type { MilestoneNoteRow } from '@tender/shared';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';

const KIND_LABEL: Record<MilestoneNoteRow['kind'], string> = {
  submit: 'Submitted for review',
  request_changes: 'Requested changes',
  reject: 'Rejected',
  accept: 'Accepted',
  dispute_propose: 'Dispute proposal',
  comment: 'Comment',
};

const KIND_TONE: Record<MilestoneNoteRow['kind'], string> = {
  submit: 'border-primary/30 bg-primary/5 text-primary/80',
  request_changes: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  reject: 'border-destructive/30 bg-destructive/5 text-destructive',
  accept: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
  dispute_propose: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  comment: 'border-border bg-muted text-muted-foreground',
};

export function MilestoneNotesThread({ notes }: { notes: MilestoneNoteRow[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border/60 pt-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        Notes ({notes.length})
      </span>
      <ul className="flex flex-col gap-2">
        {notes.map((n) => (
          <li
            key={n.id}
            className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3"
          >
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span
                className={`rounded-full border px-2 py-0.5 font-medium uppercase tracking-wider ${KIND_TONE[n.kind]}`}
              >
                {KIND_LABEL[n.kind]}
              </span>
              <span className="font-mono text-muted-foreground">
                <HashLink hash={n.author_wallet} kind="account" visibleChars={10} withSns />
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                <LocalTime iso={n.created_at} />
              </span>
              {n.tx_signature && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="font-mono">
                    <HashLink hash={n.tx_signature} kind="tx" visibleChars={8} />
                  </span>
                </>
              )}
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
              {n.body}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
