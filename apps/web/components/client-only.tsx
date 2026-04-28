'use client';

import { type ReactNode, useEffect, useState } from 'react';

/**
 * Renders children only after the first client-side mount.
 *
 * Use to wrap any subtree that depends on browser-only globals
 * (window, navigator.wallets, IndexedDB, etc.) so it never runs during SSR
 * or static prerender.
 */
export function ClientOnly({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <>{fallback}</>;
  return <>{children}</>;
}
