import type { ReactNode } from 'react';

/**
 * (app) layout — public chrome, NO sign-in gate.
 *
 * Used to wrap the gate around the entire route group, but that locked
 * publicly-readable surfaces (marketplace browse, RFP detail, buyer +
 * provider profiles) behind a wallet connection — bad for SEO, bad for
 * onboarding, bad for sharing links. Those pages already handle
 * `getCurrentWallet() === null` gracefully (no "mine" badges, no
 * action panels for action surfaces).
 *
 * Action-only routes that genuinely require an authenticated session
 * impose their own gate:
 *   - `/dashboard/*`   — via `dashboard/layout.tsx`
 *   - `/rfps/new`      — per-page check
 *   - `/rfps/[id]/bid` — per-page check
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
