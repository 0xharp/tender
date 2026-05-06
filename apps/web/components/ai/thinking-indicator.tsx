'use client';

/**
 * Cycles through a list of "what the AI is doing right now" phrases
 * while a request is in flight. Pure decoration — first-token latency
 * for our QVAC sidecar can be 5-20s on a cold node, which is long
 * enough that a plain spinner feels broken.
 *
 * Usage:
 *   <ThinkingIndicator phrases={DRAFT_PHRASES} />
 *
 * Each phrase shows for ~1.4s with a soft fade between. Loops back to
 * the first phrase if the request takes longer than the full list.
 */

import { LoaderIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

const TICK_MS = 1400;

export const RFP_SCOPE_PHRASES = [
  'Thinking through the ask…',
  'Drafting objectives…',
  'Sketching deliverables…',
  'Sizing milestones…',
  'Polishing the scope…',
];

export const BID_DRAFT_PHRASES = [
  'Reading the RFP…',
  'Pricing the work…',
  'Sketching milestones…',
  'Calling out risks…',
  'Polishing the draft…',
];

export const BID_COMPARE_PHRASES = [
  'Reading the bids…',
  'Comparing prices…',
  'Weighing timelines…',
  'Flagging risks…',
  'Picking a winner…',
];

export function ThinkingIndicator({
  phrases,
  className,
}: {
  phrases: readonly string[];
  className?: string;
}) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((prev) => (prev + 1) % phrases.length), TICK_MS);
    return () => clearInterval(id);
  }, [phrases.length]);
  return (
    <div className={className ?? 'flex items-center gap-2 text-xs text-muted-foreground'}>
      <LoaderIcon className="size-3.5 animate-spin shrink-0" />
      {/* key={i} forces React to remount the span so the fade-in animation
          re-triggers on every phrase swap. */}
      <span
        key={i}
        className="animate-in fade-in duration-500"
      >
        {phrases[i]}
      </span>
    </div>
  );
}
