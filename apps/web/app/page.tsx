import {
  ArrowUpRightIcon,
  GitBranchIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  ShuffleIcon,
} from 'lucide-react';
import Link from 'next/link';

import { HowItWorks } from '@/components/landing/how-it-works';
import { Stagger, StaggerItem } from '@/components/motion/stagger';
import { PoweredByLogos } from '@/components/nav/powered-by-logos';
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

      <Stagger
        className="mx-auto flex max-w-5xl flex-col items-center gap-8 text-center"
        step={0.09}
      >
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
            Private sealed-bid procurement on Solana - built for humans today, ready for AI agents
            tomorrow. Bids sit encrypted on a{' '}
            <span className="text-foreground">MagicBlock&rsquo;s TEE-backed rollup</span> - sealed
            from everyone, <span className="text-foreground">including the buyer</span>, until the
            bid window closes. Switch on private bidding and a per-RFP{' '}
            <span className="text-foreground">ephemeral wallet</span> commits your bid, funded
            through <span className="text-foreground">Cloak&rsquo;s shielded UTXO pool</span>.
            Winners surface on-chain at award reveal; losers stay anonymous forever.
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
    <div className="mx-auto mt-12 grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <DiagramCard
        icon={LockKeyholeIcon}
        title="Sealed"
        body="X25519 ECDH + XChaCha20-Poly1305 envelopes, encrypted to buyer AND provider. Plaintext never persists anywhere."
        accent="violet"
      />
      <DiagramCard
        icon={GitBranchIcon}
        title="Time-locked"
        body="Envelopes live on a MagicBlock Private Ephemeral Rollup. The TEE blocks buyer reads until bid_close_at flips the permission set."
        accent="indigo"
      />
      <DiagramCard
        icon={ShuffleIcon}
        title="Unlinkable"
        body="Private mode uses a per-RFP ephemeral wallet, funded via Cloak&rsquo;s shielded UTXO pool. Losers&rsquo; main wallets stay forever private."
        accent="fuchsia"
      />
      <DiagramCard
        icon={KeyRoundIcon}
        title="Revealed"
        body="Permission flips at close. Buyer fetches from the rollup, decrypts in-browser, picks a winner. Reveal proves the winner&rsquo;s main wallet without exposing losers&rsquo;."
        accent="violet"
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

function TrustStrip() {
  // The new PoweredByLogos block already names each partner's role + what
  // it does for tendr.bid in plain English (MagicBlock = bid-content
  // privacy, Cloak = bidder unlinkability, SNS = identity layer). The
  // separate "facts" row that previously sat under the logos repeated the
  // same info in different shorthand ("MagicBlock PER · TEE" etc.) — pure
  // duplication. Single descriptive block reads cleaner.
  return (
    <section className="px-6 pb-24 sm:pb-32">
      <div className="mx-auto max-w-5xl rounded-2xl border border-border/60 bg-card/40 p-8 backdrop-blur-md sm:p-12">
        <PoweredByLogos />
      </div>
    </section>
  );
}

function FooterCta() {
  return (
    <section className="px-6 pb-32">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border border-border/60 bg-brand-accent p-px">
        <div className="flex flex-col items-start justify-between gap-6 rounded-[calc(var(--radius-3xl)-1px)] bg-card/95 p-10 backdrop-blur-xl sm:flex-row sm:items-center">
          <div className="flex flex-col gap-2">
            <h3 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
              See it run on devnet.
            </h3>
            <p className="max-w-md text-sm text-muted-foreground">
              Connect a wallet, browse an open RFP, and submit a sealed bid. Plaintext stays in your
              browser; the commit goes on-chain.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/rfps"
              className={cn(buttonVariants({ size: 'lg' }), 'h-11 rounded-full px-6')}
            >
              Browse RFPs
            </Link>
            <Link
              href="/docs"
              className={cn(
                buttonVariants({ variant: 'outline', size: 'lg' }),
                'h-11 rounded-full px-6',
              )}
            >
              Read the docs
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
