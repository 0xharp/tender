'use client';

import { CheckIcon, DownloadIcon, LinkIcon, ShareIcon } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { OgCardPreview } from './og-card-preview';

interface ShareCardProps {
  /** Path or absolute URL to share. Used for both copy + X intent. */
  shareHref: string;
  /** X intent text. `{url}` is replaced with the resolved absolute URL. */
  shareText: string;
  /** Stable same-origin PNG endpoint (e.g. `/api/og/buyer/<wallet>`). */
  ogImageUrl: string;
  /** Filename the browser saves the download as. Include the `.png`. */
  downloadFilename: string;
  /** The OG card to render in the preview pane (server-rendered child). */
  children: ReactNode;
}

/**
 * One-stop "share this page" surface: copy the link, broadcast to X,
 * download the OG image, and see exactly what social platforms will
 * unfurl. Mirrors the visual weight of the page's other cards
 * (Reputation, Scope) so it reads as a peer section, not a banner.
 */
export function ShareCard({
  shareHref,
  shareText,
  ogImageUrl,
  downloadFilename,
  children,
}: ShareCardProps) {
  const [copied, setCopied] = useState(false);
  // SSR with the relative href (matches the server-rendered HTML so
  // hydration doesn't mismatch). Expand to absolute on mount — by then
  // we have window.location.origin and the click handlers need the full
  // URL for the X intent.
  const [fullUrl, setFullUrl] = useState(shareHref);
  useEffect(() => {
    setFullUrl(new URL(shareHref, window.location.origin).toString());
  }, [shareHref]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can be blocked in iframes / insecure contexts.
      // Manual select-and-copy via prompt is the universal fallback.
      window.prompt('Copy this link:', fullUrl);
    }
  }

  const xIntent = `https://x.com/intent/tweet?text=${encodeURIComponent(
    shareText.replace('{url}', fullUrl),
  )}`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShareIcon className="size-4 text-muted-foreground" />
          Share
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          preview · how your link unfurls
        </span>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5">
        <div className="flex w-full flex-wrap items-center justify-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCopy}
            title={fullUrl}
            className="h-8 rounded-full px-3 text-xs"
          >
            {copied ? (
              <CheckIcon className="size-3.5 text-emerald-500" />
            ) : (
              <LinkIcon className="size-3.5" />
            )}
            {copied ? 'Copied' : 'Copy link'}
          </Button>

          <a
            href={xIntent}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-card"
          >
            <ShareIcon className="size-3.5" />
            Share to X
          </a>

          <a
            href={ogImageUrl}
            download={downloadFilename}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium transition-colors hover:bg-card"
          >
            <DownloadIcon className="size-3.5" />
            Download image
          </a>
        </div>

        <OgCardPreview>{children}</OgCardPreview>
      </CardContent>
    </Card>
  );
}
