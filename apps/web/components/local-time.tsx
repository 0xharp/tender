'use client';

import { useEffect, useState } from 'react';

const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/**
 * Renders an ISO timestamp in the viewer's local timezone.
 *
 * Server components render in the server's TZ (typically UTC on Vercel /
 * Linux). Wrapping the timestamp in this client component re-renders it on
 * hydration with the browser's TZ, so users see localized time + a clear
 * abbreviation ("IST", "PDT", "UTC", etc).
 */
export function LocalTime({ iso }: { iso: string }) {
  // SSR pass: render in server TZ so the markup is identical to what the
  // client will hydrate to (avoids hydration mismatch warnings). The useEffect
  // reformats once on the client with the browser TZ.
  const [text, setText] = useState(() => new Date(iso).toLocaleString('en-US', FORMAT_OPTIONS));

  useEffect(() => {
    setText(new Date(iso).toLocaleString('en-US', FORMAT_OPTIONS));
  }, [iso]);

  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}
