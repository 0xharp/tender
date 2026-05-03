'use client';

import { ArrowUpRightIcon, CheckIcon, CopyIcon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';

import { cn } from '@/lib/utils';

export interface HashLinkProps {
  /** The full string to display + copy. */
  hash: string;
  /**
   * Solscan link kind: `account`, `tx`, or `none` (no auto-link).
   * If `href` is also provided, `href` wins.
   */
  kind?: 'account' | 'tx' | 'none';
  /** Cluster suffix; defaults to devnet during the devnet phase. */
  cluster?: 'devnet' | 'mainnet-beta' | 'testnet';
  /** Chars to show before + after the ellipsis. Default 6. */
  visibleChars?: number;
  /** Explicit URL override. Wins over `kind`-derived Solscan URL. */
  href?: string;
  /** Open the link in a new tab. Default true (Solscan); set false for internal routes. */
  external?: boolean;
  /** Show the copy-to-clipboard affordance. Default true. */
  copyable?: boolean;
  /** Render the truncated text as a link. Default true if a URL is resolvable. */
  linkable?: boolean;
  className?: string;
}

const COPY_FEEDBACK_MS = 1500;

/**
 * Centralized address / hash / tx display. Truncates to first+last N chars,
 * links to Solscan (or a custom href / internal route), and exposes a
 * one-click copy button that morphs to a tick on success.
 *
 * Default behavior (just `hash + kind`) gives you Solscan-linked text + copy.
 * For copy-only display (e.g. commit hashes that aren't Solscan-addressable),
 * pass `kind="none"`. For internal routes, pass `href` + `external={false}`.
 */
export function HashLink({
  hash,
  kind = 'account',
  cluster = 'devnet',
  visibleChars = 6,
  href,
  external,
  copyable = true,
  linkable = true,
  className,
}: HashLinkProps) {
  const [copied, setCopied] = useState(false);

  const resolvedHref =
    href ?? (kind === 'none' ? null : `https://solscan.io/${kind}/${hash}?cluster=${cluster}`);
  const showLink = linkable && resolvedHref !== null;
  const opensExternal = external ?? !href;

  const display =
    hash.length <= visibleChars * 2 + 1
      ? hash
      : `${hash.slice(0, visibleChars)}…${hash.slice(-visibleChars)}`;

  const copy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard API can fail in insecure contexts or denied permissions -
      // fail silently rather than throwing into a UI we can't control here.
    }
  };

  const labelEl = (
    <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums">
      {display}
      {showLink && (
        <ArrowUpRightIcon className="size-3 opacity-50 transition-opacity group-hover/hashlink:opacity-100" />
      )}
    </span>
  );

  const linkContent = showLink ? (
    <Link
      href={resolvedHref!}
      target={opensExternal ? '_blank' : undefined}
      rel={opensExternal ? 'noopener noreferrer' : undefined}
      className="group/hashlink inline-flex items-center gap-1 break-all underline-offset-4 transition-colors hover:text-primary"
    >
      {labelEl}
    </Link>
  ) : (
    labelEl
  );

  return (
    <span className={cn('inline-flex items-center gap-1.5 align-baseline', className)}>
      {linkContent}
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
          className={cn(
            'inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-all',
            'hover:border-border hover:bg-card hover:text-foreground',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
            copied &&
              'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          )}
        >
          <AnimatePresence mode="wait" initial={false}>
            {copied ? (
              <motion.span
                key="check"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="inline-flex"
              >
                <CheckIcon className="size-3" />
              </motion.span>
            ) : (
              <motion.span
                key="copy"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="inline-flex"
              >
                <CopyIcon className="size-3" />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      )}
    </span>
  );
}
