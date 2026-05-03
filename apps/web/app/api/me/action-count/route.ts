/**
 * GET - returns the number of projects in `urgency: 'now'` for the signed-in
 * wallet. Backs the "needs attention" pip on the wallet nav button.
 *
 * Source of truth is the same `listProjectsForWallet()` used by /me/projects,
 * so the badge can never disagree with the workbench page.
 *
 * Performance: this fires from every signed-in page mount + every 60s. Cost
 * per call is ~2 getProgramAccounts + N fetchMilestones (one per RFP the
 * wallet is in). Acceptable at current scale; the responsible scale-up
 * would be a per-wallet cache (Redis) or a server-sent-event subscription
 * tied to on-chain account changes.
 */
import type { Address } from '@solana/kit';
import { NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { listProjectsForWallet } from '@/lib/me/projects';

// Always recompute - this is wallet-state-sensitive and can change per RFP
// action. The 60s client-side polling interval gives the cache enough buffer.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const wallet = await getCurrentWallet();
  if (!wallet) {
    return NextResponse.json({ count: 0 });
  }
  try {
    const rows = await listProjectsForWallet(wallet as Address);
    const count = rows.filter((r) => r.nextAction.urgency === 'now').length;
    return NextResponse.json({ count });
  } catch (e) {
    // Don't 500 here - the badge is a UX nicety, not load-bearing. Log + return 0.
    console.error('[action-count] failed', e);
    return NextResponse.json({ count: 0 });
  }
}
