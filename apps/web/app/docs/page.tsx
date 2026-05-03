import { ArrowRightIcon, BookOpenIcon } from 'lucide-react';
import Link from 'next/link';

import { SectionHeader } from '@/components/primitives/section-header';
import { Card, CardContent } from '@/components/ui/card';
import { listDocsMeta } from '@/lib/docs/load';

export const metadata = {
  title: 'Docs · tendr.bid',
  description:
    'Reference documentation for tendr.bid: privacy model, RFP lifecycle, on-chain reputation, and the architecture behind sealed-bid procurement on Solana.',
};

export default function DocsIndexPage() {
  const docs = listDocsMeta();
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <SectionHeader
        eyebrow="Reference"
        title="Documentation"
        size="md"
        description={
          <span className="text-muted-foreground">
            Canonical reference for the cryptography, on-chain state machine, and reputation system
            behind tendr.bid. The same .md files render here and on GitHub - one source of truth.
          </span>
        }
      />

      <ul className="flex flex-col gap-4">
        {docs.map((d) => (
          <li key={d.slug}>
            <Link href={`/docs/${d.slug}`}>
              <Card className="transition-colors hover:border-primary/40 hover:bg-primary/5">
                <CardContent className="flex flex-col gap-2 p-5">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    {d.eyebrow}
                  </span>
                  <h2 className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
                    <BookOpenIcon className="size-4 text-primary" />
                    {d.title}
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{d.description}</p>
                  <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-primary">
                    Read the doc <ArrowRightIcon className="size-3" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
