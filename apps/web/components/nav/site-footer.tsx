import { ArrowUpRightIcon } from 'lucide-react';
import Link from 'next/link';
import type { SVGProps } from 'react';

import { TenderMark } from '@/components/nav/tender-mark';

const TENDER_REPO = 'https://github.com/0xharp/tender';
const X_HANDLE = 'https://x.com/0xharp';
const PORTFOLIO = 'https://0xharp.dev';

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background/40">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-foreground transition-colors hover:text-primary"
            aria-label="Tender — home"
          >
            <TenderMark className="size-5 text-primary" />
            <span className="font-display text-sm font-semibold tracking-tight">Tender</span>
          </Link>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            Built on Solana for the{' '}
            <ExternalText href="https://www.colosseum.org/frontier">
              Colosseum Frontier Hackathon
            </ExternalText>{' '}
            by{' '}
            <ExternalText href={X_HANDLE}>0xharp</ExternalText>
            <span aria-hidden> · </span>
            <ExternalText href={PORTFOLIO}>0xharp.dev</ExternalText>
          </p>
        </div>

        <nav
          className="flex flex-wrap items-center gap-2"
          aria-label="External links"
        >
          <FooterIconLink href={TENDER_REPO} label="Source on GitHub">
            <GithubIcon className="size-3.5" />
            github
          </FooterIconLink>
          <FooterIconLink href={X_HANDLE} label="Follow on X">
            <XBrandIcon className="size-3" />
            @0xharp
          </FooterIconLink>
          <FooterIconLink href={PORTFOLIO} label="Portfolio">
            <ArrowUpRightIcon className="size-3.5" />
            0xharp.dev
          </FooterIconLink>
        </nav>
      </div>
    </footer>
  );
}

function ExternalText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline-offset-4 transition-colors hover:text-primary hover:underline"
    >
      {children}
    </Link>
  );
}

function FooterIconLink({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-3 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-card hover:text-foreground"
    >
      {children}
    </Link>
  );
}

/** Inline GitHub mark — Lucide dropped brand icons. */
function GithubIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2.18c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.17.92-.26 1.9-.39 2.88-.39.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.17 3.16-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/** Inline X (Twitter) mark — Lucide dropped brand icons. */
function XBrandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
