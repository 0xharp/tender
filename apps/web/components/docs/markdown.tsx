import Markdown from 'react-markdown';
/**
 * Tailwind-styled markdown renderer for the in-app /docs/* pages.
 *
 * Uses react-markdown + remark-gfm (tables, strikethrough, autolinks) +
 * rehype-slug (heading IDs for anchor links from anywhere in the app) +
 * rehype-autolink-headings (each heading becomes a clickable anchor).
 *
 * No syntax highlighter today - code blocks render as monospace boxes which
 * is enough for the reference docs we ship. We can layer shiki on later if
 * we need it.
 */
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';

export function DocMarkdown({ source }: { source: string }) {
  return (
    <article className="docs-prose flex flex-col gap-5">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: 'wrap',
              properties: { className: 'doc-heading-anchor' },
            },
          ],
        ]}
        components={{
          h1: ({ children, ...props }) => (
            <h1
              {...props}
              className="font-display text-2xl font-semibold tracking-tight scroll-mt-20"
            >
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2
              {...props}
              className="mt-6 font-display text-xl font-semibold tracking-tight scroll-mt-20 border-b border-border/40 pb-2"
            >
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3
              {...props}
              className="mt-4 font-display text-base font-semibold tracking-tight scroll-mt-20"
            >
              {children}
            </h3>
          ),
          h4: ({ children, ...props }) => (
            <h4 {...props} className="mt-3 font-display text-sm font-semibold tracking-tight">
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="text-sm leading-relaxed text-foreground/85">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="ml-5 flex list-disc flex-col gap-1.5 text-sm leading-relaxed text-foreground/85 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-5 flex list-decimal flex-col gap-1.5 text-sm leading-relaxed text-foreground/85 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
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
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary/40 bg-primary/5 px-4 py-2 text-sm leading-relaxed text-foreground/85">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <code className="font-mono text-[12px] leading-relaxed text-foreground">
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/40 p-4 text-[12px]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-xl border border-border/60">
              <table className="w-full text-left text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="border-b border-border/60 bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              {children}
            </thead>
          ),
          th: ({ children }) => <th className="px-3 py-2 font-medium">{children}</th>,
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border/40 [&>tr>td]:px-3 [&>tr>td]:py-2.5 [&>tr>td]:align-top">
              {children}
            </tbody>
          ),
          hr: () => <hr className="my-2 border-border/60" />,
        }}
      >
        {source}
      </Markdown>
    </article>
  );
}
