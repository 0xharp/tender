import { TrendingUpIcon } from 'lucide-react';

export const metadata = {
  title: 'Leaderboard - tendr.bid',
  description: 'Provider reputation rankings on the tendr.bid procurement marketplace.',
};

export default function LeaderboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          public ranking
        </span>
        <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          Provider leaderboard
        </h1>
        <p className="max-w-2xl text-base text-muted-foreground">
          On-chain reputation accrues as providers bid, win, and ship milestones. The registry ships
          in the next phase - for now, the marketplace shows you what's open.
        </p>
      </header>

      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 bg-card/40 p-12 text-center backdrop-blur-md">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <TrendingUpIcon className="size-5" />
        </div>
        <div className="flex flex-col gap-2">
          <p className="font-display text-xl font-semibold tracking-tight">
            Reputation registry - coming soon
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            On-chain provider scores from completed milestones, win rate, and dispute history. Ships
            alongside the milestone state machine.
          </p>
        </div>
      </div>
    </main>
  );
}
