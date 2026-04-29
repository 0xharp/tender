'use client';

import { AnimatePresence, motion } from 'motion/react';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const EASE_OUT_QUART: [number, number, number, number] = [0.16, 1, 0.3, 1];

/**
 * Soft fade+rise transition between pages. Wraps every route's content via
 * the root layout. Uses `pathname` as the AnimatePresence key so each route
 * change triggers a clean exit + enter.
 *
 * Kept restrained — the goal is "things settle into place" not "things fly
 * around." For the cinematic moment, use <RevealGlow> instead.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.32, ease: EASE_OUT_QUART }}
        className="flex w-full flex-1 flex-col"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
