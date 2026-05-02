'use client';

import { CheckIcon, LinkIcon, ShareIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

interface ProfileShareButtonProps {
  /** Absolute or relative URL to the profile to share. We prefix with the
   *  current origin so the X intent gets a real link, even on private mode
   *  where the page is rendered with a deep wallet address. */
  href: string;
  /** Suggested social copy. Placeholder `{url}` gets replaced with the full
   *  link when posting to X. */
  shareText: string;
}

/**
 * Two-button cluster: copy-to-clipboard link + open X share intent.
 * Lives next to the wallet badge on a provider profile so the owner can
 * propagate it without leaving the page.
 */
export function ProfileShareButton({ href, shareText }: ProfileShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const fullUrl =
    typeof window === 'undefined'
      ? href
      : new URL(href, window.location.origin).toString();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API can be blocked in iframes / insecure contexts. Fall
      // back to a manual select-and-copy via prompt.
      window.prompt('Copy this link:', fullUrl);
    }
  }

  const xIntent = `https://x.com/intent/tweet?text=${encodeURIComponent(
    shareText.replace('{url}', fullUrl),
  )}`;

  return (
    <div className="flex items-center gap-1.5">
      {/* Plain `title` attr instead of a Tooltip wrapper - TooltipTrigger
          itself renders a <button>, and Button is also a <button>, so
          wrapping the two produces an invalid <button><button> tree (Next 16
          flags it as a hydration error). The native title gives us the same
          "hover to see the URL" affordance without the nesting. */}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={handleCopy}
        title={fullUrl}
        className="h-7 rounded-full px-2.5 text-[11px]"
      >
        {copied ? (
          <CheckIcon className="size-3 text-emerald-500" />
        ) : (
          <LinkIcon className="size-3" />
        )}
        {copied ? 'Copied' : 'Copy link'}
      </Button>

      <a
        href={xIntent}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-background px-2.5 text-[11px] font-medium transition-colors hover:bg-card"
      >
        <ShareIcon className="size-3" />
        Share to X
      </a>
    </div>
  );
}
