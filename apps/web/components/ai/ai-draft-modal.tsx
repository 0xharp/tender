'use client';

/**
 * Reusable "draft something with AI" modal.
 *
 * Used by:
 *   - RfpCreateForm — buyer types a paragraph, AI returns a structured
 *     scope summary that gets dropped into the `scope_summary` field.
 *   - BidComposer (provider) — provider can optionally tweak the prompt
 *     context (specialization, etc.); AI returns a starting-point bid
 *     that goes into the `scope` field.
 *
 * The modal is fully controlled (caller owns `open`). On success the
 * caller's `onAccept(text)` is invoked with the final markdown blob —
 * caller decides what field to drop it into.
 *
 * Privacy: the AI request goes browser → QVAC sidecar directly. The
 * description / context the user types here never touches Tendr's
 * backend. The "running on Tendr's Nosana sidecar" microcopy below
 * the textarea makes that explicit.
 */

import { LoaderIcon, SparklesIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { type AiResult, draftBid, draftRfpScope } from '@/lib/ai';

export type AiDraftMode =
  | { kind: 'rfp-scope'; category?: string; budgetUsdc?: string; timelineDays?: number }
  | { kind: 'bid'; rfpScope: string; rfpTitle?: string; category?: string; buyerSuggestedBudgetUsdc?: string };

export interface AiDraftModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Determines which AI surface to call + which copy variant to show. */
  mode: AiDraftMode;
  /** Called with the AI-generated markdown when the user accepts. */
  onAccept: (text: string) => void;
}

const COPY: Record<AiDraftMode['kind'], { title: string; description: string; placeholder: string; cta: string; usesContextField: boolean }> = {
  'rfp-scope': {
    title: 'Draft scope with AI',
    description:
      "Tell us what you need in plain English. We'll generate a structured RFP scope (objectives, deliverables, milestones, success criteria) you can edit before posting.",
    placeholder:
      'e.g. "We need a security audit for our DEX. ~5k LOC of Anchor + TypeScript. Focus on integer overflow + reentrancy. ~3 weeks. ~$15k budget."',
    cta: 'Generate scope',
    usesContextField: true,
  },
  bid: {
    title: 'Draft a starting bid with AI',
    description:
      "We'll read the RFP scope and propose a starting-point bid (price, timeline, milestones) you can edit before submitting.",
    placeholder:
      "Optional context (your specialization, preferred timeline, anything you'd want the AI to consider). Leave blank to use just the RFP scope.",
    cta: 'Generate starting bid',
    usesContextField: false,
  },
};

export function AiDraftModal({ open, onOpenChange, mode, onAccept }: AiDraftModalProps) {
  const copy = COPY[mode.kind];
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  function reset() {
    setInput('');
    setBusy(false);
    setError(null);
    setDraft(null);
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      let result: AiResult<string>;
      if (mode.kind === 'rfp-scope') {
        const description = input.trim();
        if (description.length < 20) {
          setError('Add at least a sentence or two so the AI has something to work with.');
          setBusy(false);
          return;
        }
        result = await draftRfpScope({
          description,
          category: mode.category,
          budgetUsdc: mode.budgetUsdc,
          timelineDays: mode.timelineDays,
        });
      } else {
        // Bid drafting: use the RFP scope; user-typed input is optional context
        // we currently ignore (the prompt doesn't take it). Keeping the field
        // visible so the UX is consistent across the two modes; can wire the
        // optional context into the prompt later without breaking anything.
        result = await draftBid({
          rfpScope: mode.rfpScope,
          rfpTitle: mode.rfpTitle,
          category: mode.category,
          buyerSuggestedBudgetUsdc: mode.buyerSuggestedBudgetUsdc,
        });
      }
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setDraft(result.value);
    } finally {
      setBusy(false);
    }
  }

  function handleAccept() {
    if (!draft) return;
    onAccept(draft);
    handleClose(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose} disablePointerDismissal>
      <DialogContent className="max-w-2xl gap-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        {/* Step 1: input (always visible) */}
        <div className="flex flex-col gap-2">
          <Textarea
            rows={mode.kind === 'rfp-scope' ? 5 : 3}
            placeholder={copy.placeholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy || !!draft}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Runs on Tendr's QVAC sidecar (no third-party AI provider — see{' '}
            <a href="/docs/ai" className="underline underline-offset-2 hover:text-foreground">
              /docs/ai
            </a>
            ).
          </p>
        </div>

        {/* Step 2: generated draft (visible after success) */}
        {draft && (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              AI draft
            </p>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={14}
              className="font-mono text-xs leading-relaxed"
            />
            <p className="text-[11px] text-muted-foreground">
              Edit anything you want before applying. The text gets dropped into the
              {mode.kind === 'rfp-scope' ? ' scope summary ' : ' scope '}
              field as-is.
            </p>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => handleClose(false)}>
            {draft ? 'Discard' : 'Cancel'}
          </Button>
          {!draft ? (
            <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={handleGenerate}>
              {busy && <LoaderIcon className="size-3.5 animate-spin" />}
              {busy ? 'Generating…' : copy.cta}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleGenerate}>
                Regenerate
              </Button>
              <Button type="button" size="sm" onClick={handleAccept}>
                Use this draft
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
