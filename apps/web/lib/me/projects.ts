/**
 * "Your projects" data layer - enumerates every RFP the connected wallet has
 * skin in (as buyer or as winning provider) and computes the next concrete
 * action they should take. Backs `/me/projects`, the operational workbench.
 *
 * Data sources are all on-chain (Rfp + MilestoneState + Escrow accounts);
 * supabase only joins the human-readable title/scope when present.
 *
 * The "next action" computation lives here (not in the page) so it can be
 * unit-tested + reused by future surfaces (notification badges, dashboard
 * preview, email digests).
 */
import type { Address } from '@solana/kit';

import {
  type MilestoneStateChain,
  fetchMilestones,
  listRfps,
  rfpStatusToString,
  unixSecondsToIso,
} from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';
import {
  type NextAction,
  type NextActionUrgency,
  type ProjectRole,
  computeNextAction,
  pickFocusMilestone,
  pickPendingDeadline,
} from './next-action';

export type { ProjectRole, NextActionUrgency, NextAction };

export interface ProjectRow {
  rfpPda: string;
  title: string | null;
  status: string;
  role: ProjectRole;
  contractValueMicroUsdc: bigint;
  /** 1-indexed milestone the user should focus on. Null when no milestone is
   *  active (pre-fund, completed, cancelled). */
  focusMilestone1Indexed: number | null;
  /** Total milestone count post-award; null pre-award. */
  milestoneCount: number;
  /** rfp.created_at as ISO; used for default sort within urgency tiers. */
  createdAtIso: string;
  /** Funding-deadline if status is awarded, else review/dispute/delivery
   *  deadline of the active milestone. ISO or null. */
  pendingDeadlineIso: string | null;
  nextAction: NextAction;
}

/**
 * Fetch all projects the wallet is involved in (buyer or winning provider).
 * Returns a flat list - the page groups by urgency.
 */
export async function listProjectsForWallet(wallet: Address): Promise<ProjectRow[]> {
  // Both queries hit getProgramAccounts with their own memcmp filter.
  const [asBuyer, asWinner] = await Promise.all([
    listRfps({ buyer: wallet }),
    listRfps({ winnerProvider: wallet }),
  ]);

  // Dedupe by PDA - if a wallet ever bought + won the same RFP (impossible
  // today since program rejects same-wallet bids, but defensive). Buyer role
  // wins the dedupe since that's the more action-heavy seat.
  const seen = new Set<string>();
  const tagged: { rfp: (typeof asBuyer)[number]; role: ProjectRole }[] = [];
  for (const r of asBuyer) {
    seen.add(r.address);
    tagged.push({ rfp: r, role: 'buyer' });
  }
  for (const r of asWinner) {
    if (seen.has(r.address)) continue;
    tagged.push({ rfp: r, role: 'provider' });
  }

  if (tagged.length === 0) return [];

  // Pull metadata + milestones in one parallel pass.
  const supabase = await serverSupabase();
  const [{ data: metaRows }, milestonesByPda] = await Promise.all([
    supabase
      .from('rfps')
      .select('on_chain_pda, title')
      .in(
        'on_chain_pda',
        tagged.map((t) => t.rfp.address),
      ),
    Promise.all(
      tagged.map(async (t) => {
        const count = t.rfp.data.milestoneCount;
        if (count === 0) return { pda: t.rfp.address, milestones: [] };
        const ms = await fetchMilestones(t.rfp.address as Address, count);
        return { pda: t.rfp.address, milestones: ms };
      }),
    ).then((arr) => {
      const out: Record<string, (MilestoneStateChain | null)[]> = {};
      for (const { pda, milestones } of arr) out[pda] = milestones;
      return out;
    }),
  ]);

  const titleByPda = new Map<string, string>();
  for (const m of metaRows ?? []) titleByPda.set(m.on_chain_pda, m.title);

  const now = Date.now();
  const rows: ProjectRow[] = tagged.map(({ rfp, role }) => {
    const status = rfpStatusToString(rfp.data.status);
    const milestones = milestonesByPda[rfp.address] ?? [];
    const next = computeNextAction({
      role,
      status,
      activeMilestoneIndex: rfp.data.activeMilestoneIndex,
      milestones,
      bidCloseAtMs: Number(rfp.data.bidCloseAt) * 1000,
      revealCloseAtMs: Number(rfp.data.revealCloseAt) * 1000,
      fundingDeadlineMs:
        rfp.data.fundingDeadline > 0n ? Number(rfp.data.fundingDeadline) * 1000 : null,
      nowMs: now,
      bidCount: rfp.data.bidCount,
    });
    const focus = pickFocusMilestone({
      activeMilestoneIndex: rfp.data.activeMilestoneIndex,
      milestones,
    });
    return {
      rfpPda: rfp.address,
      title: titleByPda.get(rfp.address) ?? null,
      status,
      role,
      contractValueMicroUsdc: rfp.data.contractValue,
      focusMilestone1Indexed: focus !== null ? focus + 1 : null,
      milestoneCount: rfp.data.milestoneCount,
      createdAtIso: unixSecondsToIso(rfp.data.createdAt),
      pendingDeadlineIso: (() => {
        const ms = pickPendingDeadline({
          status,
          rfp: rfp.data,
          milestones,
          focusIndex: focus,
        });
        return ms === null ? null : new Date(ms).toISOString();
      })(),
      nextAction: next,
    };
  });

  return rows;
}
/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectGroups {
  actionRequired: ProjectRow[];
  inProgress: ProjectRow[];
  done: ProjectRow[];
}

export function groupProjects(rows: ProjectRow[]): ProjectGroups {
  const out: ProjectGroups = { actionRequired: [], inProgress: [], done: [] };
  for (const r of rows) {
    if (r.nextAction.urgency === 'now') out.actionRequired.push(r);
    else if (r.nextAction.urgency === 'done') out.done.push(r);
    else out.inProgress.push(r);
  }
  // Sort each group: most-recent first within a tier.
  const byCreated = (a: ProjectRow, b: ProjectRow) => b.createdAtIso.localeCompare(a.createdAtIso);
  out.actionRequired.sort(byCreated);
  out.inProgress.sort(byCreated);
  out.done.sort(byCreated);
  return out;
}
