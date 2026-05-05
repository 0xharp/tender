'use client';

/**
 * Lightweight markdown renderer for inline UI surfaces (RFP scope
 * summary, AI draft preview). Different from `<DocMarkdown>` in
 * `components/docs/markdown.tsx` — that one is sized for full-page
 * documentation (large headings, anchor links, generous spacing). This
 * one is sized to live inside cards and modals: smaller headings, no
 * heading anchors, tighter line-height.
 *
 * Used for:
 *   - RFP detail page scope summary (now that buyers can drop AI-drafted
 *     markdown into the scope_summary field, we need to render it
 *     instead of showing literal `**` characters).
 *   - AI draft modal preview (so the buyer/provider can see the
 *     formatted output before hitting "Use this draft").
 *
 * react-markdown sanitizes HTML by default — markdown source can't
 * inject raw <script> tags. We don't enable rehype-raw, so even if a
 * mischievous AI response embedded HTML it would render as text.
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function InlineMarkdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={className ?? 'flex flex-col gap-3'}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="font-display text-base font-semibold tracking-tight text-foreground">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-2 font-display text-sm font-semibold tracking-tight text-foreground">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 font-display text-sm font-semibold tracking-tight text-foreground/90">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="text-sm leading-relaxed text-foreground/85">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="ml-5 flex list-disc flex-col gap-1 text-sm leading-relaxed text-foreground/85 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-5 flex list-decimal flex-col gap-1 text-sm leading-relaxed text-foreground/85 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              target={href?.startsWith('http') ? '_blank' : undefined}
              rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
              {children}
            </code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/40 bg-primary/5 px-3 py-1.5 text-sm leading-relaxed text-foreground/85">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-1 border-border/60" />,
        }}
      >
        {source}
      </Markdown>
    </div>
  );
}
