'use client';

import { useEffect, useState } from 'react';

const FORMAT_OPTIONS_FULL: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

// Compact format drops the year + the GMT offset. Year is implied when the
// date is in the current calendar year (the common case); GMT offset is
// redundant once we've already localized to the viewer's TZ.
const FORMAT_OPTIONS_COMPACT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

/**
 * Renders an ISO timestamp in the viewer's local timezone.
 *
 * Server components render in the server's TZ (typically UTC on Vercel /
 * Linux). Wrapping the timestamp in this client component re-renders it on
 * hydration with the browser's TZ, so users see localized time + a clear
 * abbreviation ("IST", "PDT", "UTC", etc).
 *
 * Pass `compact` for a tighter format (no year, no GMT offset) - use it
 * inside dense UI like the lifecycle bar where the full format would wrap.
 */
export function LocalTime({ iso, compact = false }: { iso: string; compact?: boolean }) {
  const opts = compact ? FORMAT_OPTIONS_COMPACT : FORMAT_OPTIONS_FULL;
  // SSR pass: render in server TZ so the markup is identical to what the
  // client will hydrate to (avoids hydration mismatch warnings). The useEffect
  // reformats once on the client with the browser TZ.
  const [text, setText] = useState(() => new Date(iso).toLocaleString('en-US', opts));

  useEffect(() => {
    setText(new Date(iso).toLocaleString('en-US', opts));
  }, [iso, opts]);

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
