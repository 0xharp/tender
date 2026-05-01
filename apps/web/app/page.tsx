import {
  ArrowUpRightIcon,
  CoinsIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import Link from 'next/link';

import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function Home() {
  return (
    <main className="relative isolate flex flex-col">
      <Hero />
      <HowItWorks />
      <TrustStrip />
      <FooterCta />
    </main>
  );
}

function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-brand-bg px-6 pt-20 pb-28 sm:pt-28 sm:pb-36">
      <Aurora />

      <Stagger className="mx-auto flex max-w-5xl flex-col items-center gap-8 text-center" step={0.09}>
        <StaggerItem>
          <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground backdrop-blur-md">
            <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60" />
            Live on Solana devnet
          </span>
        </StaggerItem>

        <StaggerItem>
          <h1 className="font-display text-5xl font-semibold leading-[0.95] tracking-tight text-balance sm:text-7xl md:text-[88px]">
            Procurement,
            <br />
            <span className="bg-gradient-to-r from-primary via-primary to-fuchsia-500 bg-clip-text text-transparent">
              sealed.
            </span>
          </h1>
        </StaggerItem>

        <StaggerItem>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Sealed-bid RFPs for crypto-native organizations. Bids stay encrypted on a{' '}
            <span className="text-foreground">MagicBlock TEE-backed rollup</span> — sealed from
            everyone, <span className="text-foreground">including the buyer</span>, until the bid
            window closes. Optional private bidder list keeps the bidder pool itself confidential.
          </p>
        </StaggerItem>

        <StaggerItem>
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <Link
              href="/rfps"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-11 rounded-full px-7 text-sm shadow-lg shadow-primary/20',
              )}
            >
              Browse open RFPs
            </Link>
            <Link
              href="/rfps/new"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'h-11 gap-2 rounded-full border-border/80 bg-card/40 px-7 text-sm backdrop-blur-md',
              )}
            >
              Post an RFP <ArrowUpRightIcon className="size-3.5" />
            </Link>
          </div>
        </StaggerItem>

        <StaggerItem className="w-full">
          <HeroDiagram />
        </StaggerItem>
      </Stagger>
    </section>
  );
}

function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-primary/20 blur-3xl dark:bg-primary/25" />
      <div className="absolute -top-20 left-[15%] size-[420px] rounded-full bg-fuchsia-500/15 blur-3xl dark:bg-fuchsia-500/20" />
      <div className="absolute top-40 right-[10%] size-[380px] rounded-full bg-indigo-500/15 blur-3xl dark:bg-indigo-500/20" />
      <div
        className="absolute inset-0 opacity-[0.04] dark:opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 60% 50% at 50% 30%, black, transparent 80%)',
        }}
      />
    </div>
  );
}

function HeroDiagram() {
  return (
    <div className="mt-12 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
      <DiagramCard
        icon={LockKeyholeIcon}
        title="Sealed"
        body="ECIES envelopes encrypted to buyer + provider. Plaintext never persists anywhere."
        accent="violet"
      />
      <DiagramCard
        icon={GitBranchIcon}
        title="Time-locked"
        body="Envelopes live on MagicBlock PER. The TEE blocks buyer reads until bid window closes."
        accent="indigo"
        elevated
      />
      <DiagramCard
        icon={KeyRoundIcon}
        title="Revealed"
        body="Permission flips at close. Buyer fetches from the rollup, decrypts in-browser."
        accent="fuchsia"
      />
    </div>
  );
}

function DiagramCard({
  icon: Icon,
  title,
  body,
  accent,
  elevated,
}: {
  icon: typeof LockKeyholeIcon;
  title: string;
  body: string;
  accent: 'violet' | 'indigo' | 'fuchsia';
  elevated?: boolean;
}) {
  const accentClass = {
    violet: 'text-primary shadow-primary/30',
    indigo: 'text-indigo-400 shadow-indigo-500/30',
    fuchsia: 'text-fuchsia-400 shadow-fuchsia-500/30',
  }[accent];

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-5 text-left backdrop-blur-xl transition-all',
        'hover:-translate-y-1 hover:border-border hover:bg-card/60',
        elevated &&
          'sm:-translate-y-3 sm:scale-[1.04] sm:bg-card/60 sm:shadow-2xl sm:shadow-primary/10',
      )}
    >
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-lg bg-card/80 shadow-md',
          accentClass,
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: '01',
      title: 'Post an RFP',
      body: 'Buyer creates a request with scope, budget range, milestones, and a reveal window. Pick public or private bidder list per RFP. The RFP-specific X25519 pubkey is derived from a single wallet signature.',
    },
    {
      n: '02',
      title: 'Providers commit',
      body: 'Each bid is ECIES-encrypted to buyer + provider, then chunked onto a delegated BidCommit account on MagicBlock\'s Private Ephemeral Rollup. Permission gating means even the buyer can\'t read until the window closes.',
    },
    {
      n: '03',
      title: 'Reveal opens',
      body: 'After bid_close_at, anyone can call open_reveal_window. The on-chain time gate flips the permission set to add the buyer; the TEE-backed validator starts serving envelope reads to the buyer\'s wallet.',
    },
    {
      n: '04',
      title: 'Select & pay',
      body: 'Buyer decrypts every bid in-browser, picks a winner, and locks USDC into milestone escrow. Releases on-chain at each confirmed deliverable. Cross-chain payouts via Ika dWallets.',
    },
  ];

  return (
    <section className="relative px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <div className="mb-14 flex flex-col items-start gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            The flow
          </span>
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Privacy is the mechanism, not a feature.
          </h2>
          <p className="max-w-2xl text-base text-muted-foreground">
            Every step uses real cryptography. No off-chain trust, no platform-side decryption, no
            ad-hoc workaround.
          </p>
        </div>

        <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((step) => (
            <li
              key={step.n}
              className="flex flex-col gap-3 bg-card p-6 transition-colors hover:bg-card/80"
            >
              <span className="font-mono text-xs text-primary">{step.n}</span>
              <p className="font-medium text-foreground">{step.title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function TrustStrip() {
  const facts = [
    { icon: ShieldCheckIcon, label: 'Time-locked storage', value: 'MagicBlock PER · TEE' },
    { icon: GitBranchIcon, label: '11 on-chain instructions', value: 'Anchor 0.32' },
    { icon: CoinsIcon, label: 'Settlement rail', value: 'USDC · cross-chain' },
    { icon: LockKeyholeIcon, label: 'Cryptography', value: 'X25519 + XChaCha20' },
  ];

  return (
    <section className="px-6 pb-24 sm:pb-32">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 rounded-2xl border border-border/60 bg-card/40 p-2 backdrop-blur-md sm:grid-cols-2 lg:grid-cols-4">
        {facts.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-center gap-3 rounded-xl px-4 py-3">
            <Icon className="size-4 text-primary" />
            <div className="flex flex-col">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </span>
              <span className="font-mono text-sm tabular-nums">{value}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FooterCta() {
  return (
    <section className="px-6 pb-32">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border border-border/60 bg-brand-accent p-px">
        <div
          className="flex flex-col items-start justify-between gap-6 rounded-[calc(var(--radius-3xl)-1px)] bg-card/95 p-10 backdrop-blur-xl sm:flex-row sm:items-center"
        >
          <div className="flex flex-col gap-2">
            <h3 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              See it run on devnet.
            </h3>
            <p className="max-w-md text-sm text-muted-foreground">
              Connect a wallet, browse an open RFP, and submit a sealed bid. Plaintext stays in
              your browser; the commit goes on-chain.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/rfps"
              className={cn(buttonVariants({ size: 'lg' }), 'h-11 rounded-full px-6')}
            >
              Browse RFPs
            </Link>
            <a
              href="https://github.com/0xharp/tender"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'lg' }),
                'h-11 gap-2 rounded-full px-4',
              )}
            >
              Source <ArrowUpRightIcon className="size-3.5" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
