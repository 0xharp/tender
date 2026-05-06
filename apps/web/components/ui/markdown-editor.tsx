'use client';

/**
 * Tabbed markdown editor — Edit / Preview in a single textbox area.
 *
 * Drop-in replacement for `<Textarea>` anywhere we accept markdown
 * source from a user (or AI). Used by:
 *   - AI draft modal (replaces the stacked textarea + below-preview)
 *   - RFP create form scope_summary
 *   - Bid composer scope
 *
 * Behavior:
 *   - "Edit" tab: a real `<Textarea>` so all the usual form niceties
 *     work (focus, autofocus, keyboard, `field-sizing-content`).
 *   - "Preview" tab: same physical box, same min-height, same border,
 *     renders `<InlineMarkdown>` of the current value. If the value is
 *     blank, shows a muted placeholder rather than an empty box.
 *
 * Why both tabs share the box dimensions: tab-switching shouldn't make
 * the form jump (the wrapping card resizes if the editor changes
 * height). We pin a min-h that matches the textarea's initial rows.
 *
 * This component is uncontrolled-friendly via `value` + `onChange`
 * (mirroring the textarea API), so RHF's `register()` can't be passed
 * directly — callers wire it through `Controller` or `setValue`. The
 * existing forms already do this for other RHF-controlled fields.
 */

import { useId, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { InlineMarkdown } from './markdown';

export interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  rows?: number;
  /** Called when the editor wants focus (e.g. parent autofocus pattern). */
  autoFocus?: boolean;
  disabled?: boolean;
  /** Custom className for the outer wrapper. */
  className?: string;
  /** Optional id for the underlying textarea (so a `<Label htmlFor>`
   *  outside still focuses the right element). */
  id?: string;
  /** Optional aria-invalid to forward into the textarea. */
  ariaInvalid?: boolean;
  /** Initial tab. Default 'edit' for forms where the user is typing;
   *  pass 'preview' for AI-drafted content where the rendered view is
   *  the more useful initial display. */
  defaultTab?: 'edit' | 'preview';
}

const TAB_VALUES = { edit: 'edit', preview: 'preview' } as const;

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  autoFocus,
  disabled,
  className,
  id,
  ariaInvalid,
  defaultTab = 'edit',
}: MarkdownEditorProps) {
  // Initial tab from prop — caller decides whether the user lands on
  // the editor (typing flow) or the preview (AI-output review flow).
  // Switching back to Edit doesn't lose the textarea's caret position
  // because we remount it on every tab change; that's acceptable since
  // users almost never go Edit → Preview → Edit mid-keystroke.
  const [tab, setTab] = useState<'edit' | 'preview'>(defaultTab);
  const generatedId = useId();
  const textareaId = id ?? `markdown-editor-${generatedId}`;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'edit' | 'preview')}>
        <TabsList variant="line" className="self-start">
          <TabsTrigger value={TAB_VALUES.edit}>Edit</TabsTrigger>
          <TabsTrigger value={TAB_VALUES.preview}>Preview</TabsTrigger>
        </TabsList>

        {/* mt-3 lifts the panel below the underline indicator on the
            "line" variant of tabs (which lives at -bottom-[5px]). */}
        <TabsContent value={TAB_VALUES.edit} className="mt-3">
          <Textarea
            id={textareaId}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            disabled={disabled}
            aria-invalid={ariaInvalid}
            className="font-mono text-xs leading-relaxed"
          />
        </TabsContent>

        <TabsContent value={TAB_VALUES.preview} className="mt-3">
          {/* min-h roughly matches the textarea's initial rows so the
              tab switch doesn't collapse the box height when the
              draft is empty. The border + bg mirror the textarea
              chrome so the swap reads as a visual mode toggle, not a
              layout change. */}
          <div
            className="flex min-h-[10rem] w-full rounded-lg border border-input bg-transparent px-2.5 py-2 dark:bg-input/30"
            style={{ minHeight: `${Math.max(rows, 4) * 1.5}rem` }}
          >
            {value.trim().length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing to preview yet — switch to Edit and type something.
              </p>
            ) : (
              <InlineMarkdown source={value} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
