'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';

const EASE_OUT_QUART: [number, number, number, number] = [0.16, 1, 0.3, 1];

export interface RevealGlowProps {
  /** When true, the violet glow sweep + scale plays once. */
  active: boolean;
  children: ReactNode;
}

/**
 * One-shot reveal wrapper for the decryption-reveal hero moment. Renders a
 * violet beam that sweeps left-to-right across the children when `active`
 * flips from false → true.
 *
 * Use this around the bid-card list when the user clicks "Reveal my bids" -
 * the glow lands as the plaintext fields fade in.
 */
export function RevealGlow({ active, children }: RevealGlowProps) {
  return (
    <div className="relative isolate">
      <AnimatePresence>
        {active && (
          <motion.div
            key="glow"
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-2xl"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <motion.div
              className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-primary/40 to-transparent blur-2xl"
              initial={{ x: '-100%' }}
              animate={{ x: '300%' }}
              transition={{ duration: 1.6, ease: EASE_OUT_QUART }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </div>
  );
}

const itemVariants = {
  sealed: { opacity: 0, y: 8, filter: 'blur(8px)' },
  revealed: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.55, ease: EASE_OUT_QUART },
  },
};

/**
 * Per-field unlock animation. Use inside a bid card's plaintext section to
 * have price / scope / milestones each fade-up independently after the seal
 * breaks.
 */
export function UnlockField({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <motion.div initial="sealed" animate="revealed" variants={itemVariants} transition={{ delay }}>
      {children}
    </motion.div>
  );
}
