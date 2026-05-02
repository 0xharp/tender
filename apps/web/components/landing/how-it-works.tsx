'use client';

/**
 * "How it works" - four lifecycle steps with a one-shot fade-up entrance per
 * card as it scrolls into view.
 *
 * Why this version is cheap (vs the earlier scroll-scrubbed FlowAnimation):
 *
 *   - `whileInView` with `once: true` runs each card's entrance ONE TIME the
 *     first time the card crosses the viewport. After that the card is static
 *     - no scroll-frame subscriptions, no useTransform chains, no sticky
 *     pinning fighting the page-transition wrapper.
 *
 *   - Per-card `delay` derived from the array index gives the staggered feel
 *     without a parent <Stagger> coordinator (which forces the parent to be
 *     a single motion node - works, but adds a layer for nothing here).
 *
 *   - Each card includes a small "on chain" caption - real instruction names
 *     so the marketing copy ties to the deployed program, not a vague pitch.
 */
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';

const STEPS = [
  {
    n: '01',
    title: 'Post an RFP',
    body: 'Buyer creates a request with scope, budget range, and a reveal window. Picks public or private bidder list per RFP. The RFP-specific X25519 pubkey is derived from a single wallet signature.',
    chain: 'rfp_create',
  },
  {
    n: '02',
    title: 'Providers commit',
    body: "Each bid is XChaCha20-Poly1305 encrypted to buyer + provider, then chunked onto a delegated BidCommit account on MagicBlock's Private Ephemeral Rollup. Even the buyer can't read it yet.",
    chain: 'commit_bid_init → delegate_bid → write_bid_chunk → finalize_bid',
  },
  {
    n: '03',
    title: 'Reveal opens',
    body: "Past bid_close_at, anyone can call open_reveal_window. The on-chain time gate flips the TEE permission set to add the buyer; the validator starts serving envelope reads to the buyer's wallet.",
    chain: 'rfp_close_bidding → open_reveal_window',
  },
  {
    n: '04',
    title: 'Select & pay',
    body: 'Buyer decrypts every bid in-browser, picks a winner, and locks USDC into per-milestone escrow. Each release fires on-chain when the buyer accepts the deliverable, with a 14-day dispute cool-off.',
    chain: 'select_bid → fund_project → accept_milestone',
  },
] as const;

const EASE_OUT_QUART: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function HowItWorks() {
  return (
    <section className="relative px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <motion.div
          className="mb-14 flex flex-col items-start gap-3"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10% 0px' }}
          transition={{ duration: 0.6, ease: EASE_OUT_QUART }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            The flow
          </span>
          <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Privacy is the mechanism, not a feature.
          </h2>
          <p className="max-w-2xl text-base text-muted-foreground">
            Four steps, every one cryptographically enforced. Every claim below maps to a real
            on-chain instruction shipping on devnet today.
          </p>
        </motion.div>

        <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <motion.li
              key={step.n}
              className={cn(
                'group flex flex-col gap-3 bg-card p-6',
                'transition-colors hover:bg-card/85',
              )}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-15% 0px' }}
              transition={{
                duration: 0.55,
                ease: EASE_OUT_QUART,
                // Stagger derived from index - no parent coordinator needed.
                // 0.1s per card = 0.4s total entrance feels like a sequence
                // without dragging.
                delay: i * 0.1,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-xs text-primary">{step.n}</span>
                <span
                  aria-hidden
                  className="h-px w-8 bg-gradient-to-r from-primary/50 to-transparent"
                />
              </div>
              <p className="font-medium text-foreground">{step.title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{step.body}</p>
              <code className="mt-1 inline-flex flex-wrap rounded-md border border-dashed border-primary/30 bg-primary/5 px-2 py-1 font-mono text-[10px] leading-relaxed text-primary/90">
                {step.chain}
              </code>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
