'use client';

import { motion } from 'motion/react';
import type { ComponentPropsWithoutRef } from 'react';

export type HoverCardProps = ComponentPropsWithoutRef<typeof motion.div>;

/**
 * Card-like wrapper with a subtle Framer hover lift + tap squish. Replaces
 * brittle `hover:-translate-y-px` CSS with a spring that feels physical.
 */
export function HoverCard({ children, ...props }: HoverCardProps) {
  return (
    <motion.div
      whileHover={{ y: -3, transition: { type: 'spring', stiffness: 320, damping: 24 } }}
      whileTap={{ scale: 0.985, transition: { duration: 0.12 } }}
      {...props}
    >
      {children}
    </motion.div>
  );
}
