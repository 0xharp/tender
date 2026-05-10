'use client';

/**
 * Inline "syncing private data…" indicator for dashboard pages.
 * Renders a small spinner + label when MyActivity is enumerating
 * (initial load or after a refresh trigger). Disappears once the
 * fresh enumerate completes. Same pattern as the wallet popover's
 * trigger button — gives the user a consistent signal that counts
 * + lists may still be settling.
 */
import { LoaderCircleIcon } from 'lucide-react';

import { useMyActivity } from '@/lib/wallet';

export function DashboardSyncIndicator() {
  const activity = useMyActivity();
  if (!activity.isLoading) return null;
  return (
    <span
      title="Loading your private (HD-keychain) RFPs + bids…"
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/40 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
    >
      <LoaderCircleIcon className="size-2.5 animate-spin" />
      syncing
    </span>
  );
}
