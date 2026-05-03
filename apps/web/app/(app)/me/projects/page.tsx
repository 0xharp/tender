import type { Address } from '@solana/kit';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ClockIcon,
  ListChecksIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import Link from 'next/link';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { SectionHeader } from '@/components/primitives/section-header';
import { StatusPill, type StatusTone } from '@/components/primitives/status-pill';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentWallet } from '@/lib/auth/session';
import {
  type NextActionUrgency,
  type ProjectRow,
  groupProjects,
  listProjectsForWallet,
} from '@/lib/me/projects';
import { microUsdcToDecimal } from '@/lib/solana/chain-reads';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // The (app) layout already gates on sign-in via SignInGate, so wallet is
  // non-null by the time this server component runs. The cast keeps types
  // honest without re-doing the gate.
  const wallet = (await getCurrentWallet()) as Address;
  const rows = await listProjectsForWallet(wallet);
  const groups = groupProjects(rows);
  const totalCount = rows.length;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <SectionHeader
        eyebrow="My projects"
        title="Your operational workbench"
        description={
          <span className="text-muted-foreground">
            Every RFP where <strong className="text-foreground">you're the buyer</strong> or{' '}
            <strong className="text-foreground">you're the awarded provider</strong> — both roles in
            one place, with the next concrete step for each. Action-required surfaces first.
          </span>
        }
        size="md"
      />

      {totalCount === 0 ? (
        <EmptyState />
      ) : (
        <>
          <Group
            tone="urgent"
            icon={<TriangleAlertIcon className="size-4" />}
            title={`Action required (${groups.actionRequired.length})`}
            subtitle="You're blocking forward progress on these."
            rows={groups.actionRequired}
          />
          <Group
            tone="wait"
            icon={<ClockIcon className="size-4" />}
            title={`In progress (${groups.inProgress.length})`}
            subtitle="Counterparty's turn or no action required right now."
            rows={groups.inProgress}
          />
          <Group
            tone="done"
            icon={<CheckCircleIcon className="size-4" />}
            title={`Settled (${groups.done.length})`}
            subtitle="Completed, cancelled, or ghosted - history only."
            rows={groups.done}
          />
        </>
      )}
    </main>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecksIcon className="size-4 text-muted-foreground" />
          No projects yet
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          You'll see projects here once you create an RFP as a buyer, or once you win one as a
          provider.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/rfps/new"
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20"
          >
            Create an RFP <ArrowRightIcon className="size-3" />
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/40 px-3 py-1.5 text-xs hover:bg-card"
          >
            Browse the marketplace <ArrowRightIcon className="size-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function Group({
  tone,
  icon,
  title,
  subtitle,
  rows,
}: {
  tone: 'urgent' | 'wait' | 'done';
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  rows: ProjectRow[];
}) {
  if (rows.length === 0) return null;
  const headerTone =
    tone === 'urgent'
      ? 'text-amber-700 dark:text-amber-400'
      : tone === 'wait'
        ? 'text-foreground'
        : 'text-muted-foreground';
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className={headerTone}>{icon}</span>
        <h2 className={`font-display text-sm font-semibold ${headerTone}`}>{title}</h2>
        <span className="text-[11px] text-muted-foreground">· {subtitle}</span>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.rfpPda}>
            <ProjectCard row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProjectCard({ row }: { row: ProjectRow }) {
  const tone = urgencyTone(row.nextAction.urgency);
  return (
    <Link
      href={`/rfps/${row.rfpPda}`}
      className={`block rounded-2xl border ${tone.border} ${tone.bg} p-4 transition-colors hover:bg-card`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-display text-base font-semibold">
              {row.title ?? 'Untitled RFP'}
            </span>
            <RoleBadge role={row.role} />
            <StatusPill tone={statusTone(row.status)}>{row.status}</StatusPill>
          </div>
          <div className="flex flex-wrap items-baseline gap-3 font-mono text-[11px] text-muted-foreground">
            <HashLink hash={row.rfpPda} kind="account" visibleChars={6} />
            <span>·</span>
            <span>${microUsdcToDecimal(row.contractValueMicroUsdc)}</span>
            {row.milestoneCount > 0 && (
              <>
                <span>·</span>
                <span>
                  {row.focusMilestone1Indexed
                    ? `milestone ${row.focusMilestone1Indexed} of ${row.milestoneCount}`
                    : `${row.milestoneCount} milestones`}
                </span>
              </>
            )}
            {row.pendingDeadlineIso && (
              <>
                <span>·</span>
                <span>
                  by <LocalTime iso={row.pendingDeadlineIso} />
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs hover:bg-card">
          Open <ArrowRightIcon className="size-3" />
        </div>
      </div>
      <div className={`mt-3 flex flex-col gap-0.5 rounded-lg px-3 py-2 ${tone.callout}`}>
        <span className={`font-display text-sm font-semibold ${tone.calloutText}`}>
          {row.nextAction.label}
        </span>
        <span className="text-xs leading-relaxed text-muted-foreground">{row.nextAction.hint}</span>
      </div>
    </Link>
  );
}

function RoleBadge({ role }: { role: 'buyer' | 'provider' }) {
  const cls =
    role === 'buyer'
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
      : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${cls}`}
    >
      {role}
    </span>
  );
}

function urgencyTone(u: NextActionUrgency) {
  if (u === 'now') {
    return {
      border: 'border-amber-500/40',
      bg: 'bg-amber-500/5',
      callout: 'border border-amber-500/30 bg-amber-500/10',
      calloutText: 'text-amber-700 dark:text-amber-300',
    };
  }
  if (u === 'wait') {
    return {
      border: 'border-border',
      bg: 'bg-card/40',
      callout: 'bg-muted/40',
      calloutText: 'text-foreground',
    };
  }
  return {
    border: 'border-border/60',
    bg: 'bg-card/30',
    callout: 'bg-muted/30',
    calloutText: 'text-muted-foreground',
  };
}

function statusTone(status: string): StatusTone {
  if (status === 'open') return 'open';
  if (status === 'reveal') return 'reveal';
  if (status === 'awarded') return 'awarded';
  if (status === 'bidsclosed') return 'sealed';
  if (status === 'funded' || status === 'inprogress') return 'awarded';
  if (status === 'completed') return 'awarded';
  if (status === 'disputed') return 'sealed';
  return 'open';
}
