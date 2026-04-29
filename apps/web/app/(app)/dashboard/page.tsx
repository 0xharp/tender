import { ArrowUpRightIcon, FileTextIcon, GavelIcon, ScaleIcon } from 'lucide-react';
import Link from 'next/link';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { buttonVariants } from '@/components/ui/button';
import { getCurrentWallet } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { serverSupabase } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const wallet = (await getCurrentWallet()) as string;
  const supabase = await serverSupabase();

  const [{ count: rfpsPosted }, { count: bidsCommitted }, { count: openRfps }] = await Promise.all([
    supabase
      .from('rfps')
      .select('*', { count: 'exact', head: true })
      .eq('buyer_wallet', wallet),
    supabase
      .from('bid_ciphertexts')
      .select('*', { count: 'exact', head: true })
      .eq('provider_wallet', wallet),
    supabase
      .from('rfps')
      .select('*', { count: 'exact', head: true })
      .in('status', ['open', 'reveal']),
  ]);

  const tabs = [
    { href: '/dashboard', label: 'Overview' },
    { href: '/dashboard/buying', label: 'Buying', count: rfpsPosted ?? 0 },
    { href: '/dashboard/bidding', label: 'Bidding', count: bidsCommitted ?? 0 },
  ];

  return (
    <DashboardShell
      title="Workspace"
      description="Your RFPs, your bids, and the marketplace at a glance."
      tabs={tabs}
      activeHref="/dashboard"
      actions={
        <Link
          href="/rfps/new"
          className={cn(buttonVariants({ size: 'sm' }), 'h-9 gap-2 rounded-full px-4')}
        >
          New RFP <ArrowUpRightIcon className="size-3.5" />
        </Link>
      }
    >
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          icon={FileTextIcon}
          label="RFPs you've posted"
          value={rfpsPosted ?? 0}
          href="/dashboard/buying"
        />
        <StatCard
          icon={GavelIcon}
          label="Bids you've committed"
          value={bidsCommitted ?? 0}
          href="/dashboard/bidding"
        />
        <StatCard
          icon={ScaleIcon}
          label="Open marketplace RFPs"
          value={openRfps ?? 0}
          href="/rfps"
          accent
        />
      </section>

      <section className="rounded-2xl border border-border/60 bg-card p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">Quick actions</h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Devnet
          </span>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <QuickAction
            title="Post a new RFP"
            body="Define scope, budget range, milestones, and a reveal window."
            href="/rfps/new"
          />
          <QuickAction
            title="Browse the marketplace"
            body="See open RFPs across the platform. Sealed-bid commit lives here."
            href="/rfps"
          />
        </div>
      </section>
    </DashboardShell>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  href,
  accent,
}: {
  icon: typeof FileTextIcon;
  label: string;
  value: number;
  href: string;
  accent?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group relative flex flex-col gap-3 overflow-hidden rounded-2xl border bg-card p-5 transition-all',
        accent
          ? 'border-primary/30 hover:border-primary/50'
          : 'border-border/60 hover:border-border',
      )}
    >
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-lg',
          accent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-mono text-3xl font-semibold tabular-nums">{value}</p>
      </div>
      <ArrowUpRightIcon className="absolute top-5 right-5 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}

function QuickAction({ title, body, href }: { title: string; body: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1.5 rounded-xl border border-border/60 bg-background/50 p-4 transition-colors hover:border-border hover:bg-background"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        {title}
        <ArrowUpRightIcon className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </Link>
  );
}
