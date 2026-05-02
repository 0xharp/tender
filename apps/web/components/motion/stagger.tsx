'use client';

import { type Variants, motion } from 'motion/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

const EASE_OUT_QUART: [number, number, number, number] = [0.16, 1, 0.3, 1];

const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08, delayChildren: 0.05 },
  },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 16, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { duration: 0.65, ease: EASE_OUT_QUART },
  },
};

export type StaggerProps = Omit<
  ComponentPropsWithoutRef<typeof motion.div>,
  'variants' | 'initial' | 'animate'
> & {
  children: ReactNode;
  /** Delay before stagger starts (sec). */
  delay?: number;
  /** Pause between siblings (sec). Default 0.08. */
  step?: number;
};

/**
 * Container that staggers in its direct children. Each child is a
 * `<StaggerItem>` for the per-element fade+rise+blur entrance, OR any element
 * (no entrance) - the stagger only applies to motion-tagged children.
 *
 * Use sparingly - reserve for hero/landing entrances and the reveal moment.
 */
export function Stagger({ children, delay, step, ...props }: StaggerProps) {
  const variants: Variants = {
    hidden: {},
    visible: {
      transition: { staggerChildren: step ?? 0.08, delayChildren: delay ?? 0.05 },
    },
  };

  return (
    <motion.div
      {...props}
      initial="hidden"
      animate="visible"
      variants={delay !== undefined || step !== undefined ? variants : containerVariants}
    >
      {children}
    </motion.div>
  );
}

export type StaggerItemProps = Omit<ComponentPropsWithoutRef<typeof motion.div>, 'variants'>;

/** Item inside <Stagger>. Apply to each piece you want to fade/rise/unblur in. */
export function StaggerItem(props: StaggerItemProps) {
  return <motion.div {...props} variants={itemVariants} />;
}
