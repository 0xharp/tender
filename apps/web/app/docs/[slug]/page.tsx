import { ArrowRightIcon, ChevronLeftIcon, GitBranchIcon } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DocMarkdown } from '@/components/docs/markdown';
import { SectionHeader } from '@/components/primitives/section-header';
import { Card, CardContent } from '@/components/ui/card';
import {
  DOC_SLUGS,
  type DocSlug,
  docMeta,
  isDocSlug,
  listDocsMeta,
  readDocMarkdown,
} from '@/lib/docs/load';

// Read filesystem on every request so doc edits show up immediately during
// dev. The cost is one fs.readFile per visit - negligible vs the markdown
// render cost. For prod, Next route caching + the static-paths below give
// us a build-time render either way.
export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return DOC_SLUGS.map((slug) => ({ slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  if (!isDocSlug(slug)) return {};
  const meta = docMeta(slug);
  return {
    title: `${meta.title} · tendr.bid`,
    description: meta.description,
  };
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  if (!isDocSlug(slug)) notFound();
  const typedSlug = slug as DocSlug;
  const meta = docMeta(typedSlug);
  const source = await readDocMarkdown(typedSlug).catch(() => null);
  if (source == null) notFound();

  const otherDocs = listDocsMeta().filter((d) => d.slug !== typedSlug);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <Link
        href="/docs"
        className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronLeftIcon className="size-3" />
        All docs
      </Link>

      <SectionHeader
        eyebrow={meta.eyebrow}
        title={meta.title}
        size="md"
        description={<span className="text-muted-foreground">{meta.description}</span>}
        actions={
          <Link
            href={meta.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/40 px-3 py-1.5 text-xs hover:bg-card"
          >
            <GitBranchIcon className="size-3" />
            View on GitHub
          </Link>
        }
      />

      <DocMarkdown source={source} />

      {otherDocs.length > 0 && (
        <Card className="border-dashed border-border/60 bg-card/40">
          <CardContent className="flex flex-col gap-3 pt-6">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              More docs
            </span>
            <ul className="flex flex-col gap-2">
              {otherDocs.map((d) => (
                <li key={d.slug}>
                  <Link
                    href={`/docs/${d.slug}`}
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                  >
                    {d.title} <ArrowRightIcon className="size-3" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
