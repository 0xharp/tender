'use client';

/**
 * Reusable "draft something with AI" modal.
 *
 * Two surfaces, two output shapes:
 *
 *   1. RfpCreateForm (mode.kind === 'rfp-scope') — buyer types a paragraph,
 *      AI returns a single markdown blob. The whole blob lands in the
 *      scope_summary field on accept.
 *
 *   2. BidComposer (mode.kind === 'bid') — provider types optional context
 *      (tech stack, target price, timeline, specialty), AI returns a
 *      STRUCTURED bid draft (price + timeline + scope markdown + an array
 *      of milestones with their own amounts/durations/acceptance criteria).
 *      The whole structure lands in the bid form on accept — every field
 *      gets populated, not just the scope.
 *
 * The `mode` discriminator carries its own `onAccept` so the callback
 * signature is correctly narrowed at the call site (no any-cast needed).
 *
 * Privacy: the AI request goes browser → QVAC sidecar directly. The
 * description / context / scope / milestones never touch Tendr's
 * backend.
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
import { InlineMarkdown } from '@/components/ui/markdown';
import { MarkdownEditor } from '@/components/ui/markdown-editor';
import { Textarea } from '@/components/ui/textarea';
import {
  type AiResult,
  type BidDraft,
  draftBid,
  draftRfpScope,
} from '@/lib/ai';
import type { DraftBidValue } from '@/lib/ai/index';

import {
  BID_DRAFT_PHRASES,
  RFP_SCOPE_PHRASES,
  ThinkingIndicator,
} from './thinking-indicator';

/** Char cap for the rfp-scope markdown blob. Bid mode has no equivalent
 *  cap because each structured field has its own zod-validated bound
 *  (price regex, scope ≤ 8000, milestone names ≤ 120, etc.) — the BidDraft
 *  parser would have rejected an out-of-bounds field already, and the
 *  bid composer's own form validators run on accept. */
const RFP_SCOPE_CHAR_LIMIT = 4000;

export type AiDraftMode =
  | {
      kind: 'rfp-scope';
      category?: string;
      budgetUsdc?: string;
      timelineDays?: number;
      /** Accepts the full markdown blob — caller drops it into the
       *  scope_summary field as-is. */
      onAccept: (text: string) => void;
    }
  // No budget/reserve on bid drafts by design — see prompts.ts for why.
  | {
      kind: 'bid';
      rfpScope: string;
      rfpTitle?: string;
      category?: string;
      /** Accepts the full structured draft — caller wires each field
       *  into the bid form (price_usdc, timeline_days, scope, milestones[]). */
      onAccept: (draft: BidDraft) => void;
    };

export interface AiDraftModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AiDraftMode;
}

const COPY: Record<
  AiDraftMode['kind'],
  { title: string; description: string; placeholder: string; cta: string }
> = {
  'rfp-scope': {
    title: 'Draft scope with QVAC Private AI',
    description:
      "Tell us what you need in plain English. We'll generate a structured RFP scope (objectives, deliverables, milestones, success criteria) you can edit before posting.",
    placeholder:
      'e.g. "We need a security audit for our DEX. ~5k LOC of Anchor + TypeScript. Focus on integer overflow + reentrancy. ~3 weeks. ~$15k budget."',
    cta: 'Generate scope',
  },
  bid: {
    title: 'Start drafting bid with QVAC Private AI',
    description:
      "We'll read the RFP scope and propose a complete starting bid (price, timeline, milestones with acceptance criteria, scope of approach). Every field of your bid form gets populated on accept.",
    placeholder:
      "Optional but powerful — your tech stack, target price ('approx 3k USDC'), preferred timeline, specialty. The AI uses this to anchor pricing + approach.",
    cta: 'Generate starting bid',
  },
};

function DraftCharCounter({ length, max }: { length: number; max: number }) {
  const over = length > max;
  const near = !over && length > max * 0.9;
  const tone = over
    ? 'text-destructive'
    : near
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground';
  return (
    <span className={`text-[11px] tabular-nums ${tone}`}>
      {length.toLocaleString()} / {max.toLocaleString()} chars
      {over && ' — too long, trim or regenerate'}
    </span>
  );
}

export function AiDraftModal({ open, onOpenChange, mode }: AiDraftModalProps) {
  const copy = COPY[mode.kind];
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two parallel draft states — only one is populated at a time, but
  // typed separately so the renderer doesn't need any-casts.
  const [scopeDraft, setScopeDraft] = useState<string | null>(null);
  const [bidDraft, setBidDraft] = useState<DraftBidValue | null>(null);

  function reset() {
    setInput('');
    setBusy(false);
    setError(null);
    setScopeDraft(null);
    setBidDraft(null);
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    setScopeDraft(null);
    setBidDraft(null);
    try {
      if (mode.kind === 'rfp-scope') {
        const description = input.trim();
        if (description.length < 20) {
          setError('Add at least a sentence or two so the AI has something to work with.');
          setBusy(false);
          return;
        }
        const result: AiResult<string> = await draftRfpScope({
          description,
          category: mode.category,
          budgetUsdc: mode.budgetUsdc,
          timelineDays: mode.timelineDays,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setScopeDraft(result.value);
      } else {
        const result: AiResult<DraftBidValue> = await draftBid({
          rfpScope: mode.rfpScope,
          rfpTitle: mode.rfpTitle,
          category: mode.category,
          providerContext: input.trim() || undefined,
        });
        if (!result.ok) {
          setError(result.reason);
          return;
        }
        setBidDraft(result.value);
      }
    } finally {
      setBusy(false);
    }
  }

  function handleAccept() {
    if (mode.kind === 'rfp-scope' && scopeDraft) {
      mode.onAccept(scopeDraft);
      handleClose(false);
      return;
    }
    if (mode.kind === 'bid' && bidDraft?.kind === 'parsed') {
      // Risks aren't a bid form field on their own, but they're part of
      // what the provider is committing to surface to the buyer. Append
      // them as a "Caveats / clarifications" section at the end of the
      // scope markdown so they render through to the buyer's view of
      // the bid (winning-bid-panel + drawer both InlineMarkdown the
      // scope). If the AI returned no flags we leave the scope alone.
      const draft = bidDraft.draft;
      const enrichedScope =
        draft.riskFlags && draft.riskFlags.length > 0
          ? `${draft.scope.trim()}\n\n**Caveats / clarifications**\n${draft.riskFlags
              .map((f) => `- ${f}`)
              .join('\n')}`
          : draft.scope;
      mode.onAccept({ ...draft, scope: enrichedScope });
      handleClose(false);
      return;
    }
    // Bid mode + raw fallback: nothing structured to accept; user has
    // to copy/paste manually. Modal stays open.
  }

  // Acceptability gates per mode.
  const canAccept =
    mode.kind === 'rfp-scope'
      ? !!scopeDraft && scopeDraft.length <= RFP_SCOPE_CHAR_LIMIT
      : bidDraft?.kind === 'parsed';

  const hasDraft =
    mode.kind === 'rfp-scope' ? !!scopeDraft : !!bidDraft;

  return (
    <Dialog open={open} onOpenChange={handleClose} disablePointerDismissal>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border/40 p-4">
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
          {/* Step 1: input — same behavior in both modes (rfp-scope:
              required description, bid: optional context). Disabled
              once a draft has landed so the user can focus on
              accept/regenerate. */}
          <div className="flex flex-col gap-2">
            <Textarea
              rows={mode.kind === 'rfp-scope' ? 5 : 3}
              placeholder={copy.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy || hasDraft}
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

          {busy && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <ThinkingIndicator
                phrases={mode.kind === 'rfp-scope' ? RFP_SCOPE_PHRASES : BID_DRAFT_PHRASES}
              />
              <p className="pl-5 text-[10px] text-muted-foreground">
                First response on a cold sidecar can take up to a minute. Subsequent
                drafts in the same session are usually under 10 seconds.
              </p>
            </div>
          )}

          {/* Step 2 — diverges per mode. */}
          {mode.kind === 'rfp-scope' && scopeDraft && (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  AI draft (markdown)
                </p>
                <DraftCharCounter length={scopeDraft.length} max={RFP_SCOPE_CHAR_LIMIT} />
              </div>
              <MarkdownEditor value={scopeDraft} onChange={setScopeDraft} rows={10} />
              <p className="text-[11px] text-muted-foreground">
                Edit anything you want before applying. The text gets dropped into the
                scope summary field as-is — markdown formatting is preserved and rendered
                everywhere the field is shown.
              </p>
            </div>
          )}

          {mode.kind === 'bid' && bidDraft && (
            <BidDraftPreview value={bidDraft} onScopeChange={(scope) => {
              if (bidDraft.kind === 'parsed') {
                setBidDraft({ kind: 'parsed', draft: { ...bidDraft.draft, scope } });
              }
            }} />
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/40 p-4">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => handleClose(false)}>
            {hasDraft ? 'Discard' : 'Cancel'}
          </Button>
          {!hasDraft ? (
            <Button type="button" size="sm" className="gap-1.5" disabled={busy} onClick={handleGenerate}>
              {busy && <LoaderIcon className="size-3.5 animate-spin" />}
              {busy ? 'Working…' : copy.cta}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={handleGenerate}>
                Regenerate
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleAccept}
                disabled={!canAccept}
                title={
                  !canAccept
                    ? mode.kind === 'rfp-scope'
                      ? `Trim or regenerate — must be ≤ ${RFP_SCOPE_CHAR_LIMIT} characters`
                      : 'AI returned an unstructured response — copy what you need or regenerate.'
                    : undefined
                }
              >
                {mode.kind === 'bid' ? 'Use this draft (fills entire form)' : 'Use this draft'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Structured preview of a parsed bid draft. Top stats (price + timeline),
 * editable approach markdown, milestones table with sum check, optional
 * risk flags. The `onScopeChange` lifts edits back up so the parent can
 * keep the bidDraft state in sync (only the scope is editable here —
 * milestones land in the form's structured field array on accept and
 * are edited there).
 *
 * Raw fallback: when the model went off-format we render the raw text
 * with an amber warning + a manual-copy hint.
 */
function BidDraftPreview({
  value,
  onScopeChange,
}: {
  value: DraftBidValue;
  onScopeChange: (scope: string) => void;
}) {
  if (value.kind === 'raw') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          AI returned an unstructured response — couldn't parse it into bid fields.
          Copy whatever you need from the raw output below, or hit Regenerate.
        </p>
        <pre className="max-h-[40vh] overflow-auto rounded-lg border border-border/60 bg-card/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {value.text}
        </pre>
      </div>
    );
  }
  const { draft } = value;
  const milestoneSum = draft.milestones.reduce((acc, m) => acc + Number(m.amountUsdc), 0);
  const durationSum = draft.milestones.reduce((acc, m) => acc + m.durationDays, 0);
  const priceMatches = Number(draft.priceUsdc) === milestoneSum;
  const timelineMatches = draft.timelineDays === durationSum;
  return (
    <div className="flex flex-col gap-4">
      {/* Headline stats. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 p-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Price
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums">
            ${Number(draft.priceUsdc).toLocaleString()}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card/40 p-3">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Timeline
          </span>
          <span className="font-mono text-2xl font-semibold tabular-nums">
            {draft.timelineDays}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              day{draft.timelineDays === 1 ? '' : 's'}
            </span>
          </span>
        </div>
      </div>

      {/* Approach (editable markdown). */}
      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Approach (markdown · editable)
        </p>
        <MarkdownEditor value={draft.scope} onChange={onScopeChange} rows={6} />
      </div>

      {/* Milestones — read-only here; edited in the bid form after accept. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Milestones · {draft.milestones.length}
          </p>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            Σ ${milestoneSum.toLocaleString()} · {durationSum}d
          </span>
        </div>
        <ul className="flex flex-col gap-2">
          {draft.milestones.map((m, i) => (
            <li
              key={`${i}-${m.name}`}
              className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/40 p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-medium">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {i + 1}.
                  </span>{' '}
                  {m.name}
                </span>
                <div className="flex items-baseline gap-3 font-mono text-[11px] tabular-nums">
                  <span>${Number(m.amountUsdc).toLocaleString()}</span>
                  <span className="text-muted-foreground">{m.durationDays}d</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-foreground/80">
                {m.description}
              </p>
              {m.successCriteria && (
                <p className="text-[11px] italic leading-relaxed text-muted-foreground">
                  Acceptance: {m.successCriteria}
                </p>
              )}
            </li>
          ))}
        </ul>
        {(!priceMatches || !timelineMatches) && (
          <p className="text-[10px] text-amber-600 dark:text-amber-400">
            {!priceMatches && (
              <>Milestone amounts don't quite sum to the headline price — Σ ${milestoneSum.toLocaleString()} vs ${Number(draft.priceUsdc).toLocaleString()}. </>
            )}
            {!timelineMatches && (
              <>Milestone durations don't sum to the headline timeline — Σ {durationSum}d vs {draft.timelineDays}d. </>
            )}
            You can fix this in the bid form after applying, or regenerate.
          </p>
        )}
      </div>

      {/* Risk flags (optional). */}
      {draft.riskFlags && draft.riskFlags.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Things to verify with the buyer
          </p>
          <ul className="flex flex-col gap-1">
            {draft.riskFlags.map((flag, i) => (
              <li key={`risk-${i}`} className="text-[11px] leading-relaxed text-foreground/85">
                · {flag}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        On accept, every field above gets dropped into your bid form — price, timeline,
        approach (scope), all milestones with their acceptance criteria. Risk flags are
        appended to the end of your scope as a <strong>Caveats / clarifications</strong>
        section so the buyer sees them in the rendered bid. Edit anything in the form
        before submitting.
      </p>
    </div>
  );
}
