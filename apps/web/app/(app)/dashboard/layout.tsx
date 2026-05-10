import type { ReactNode } from 'react';

import { SignInGate } from '@/components/wallet/sign-in-gate';
import { getCurrentWallet } from '@/lib/auth/session';

/**
 * Dashboard subtree gate. The `/dashboard*` routes show user-specific
 * data (your RFPs, your bids, your ephemerals, claim CTAs) — they're
 * meaningless without a wallet, so we short-circuit to SignInGate when
 * no SIWS session exists.
 *
 * The previous `(app)/layout.tsx` gate covered this implicitly but also
 * locked publicly-readable surfaces (marketplace, RFP detail, profiles)
 * behind sign-in. Pushing the gate down here keeps the public reads
 * open while preserving auth on dashboard. Symmetric with per-page
 * gates on `/rfps/new` and `/rfps/[id]/bid`.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const wallet = await getCurrentWallet();
  if (!wallet) return <SignInGate />;
  return <>{children}</>;
}
