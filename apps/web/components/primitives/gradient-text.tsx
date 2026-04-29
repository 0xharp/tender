import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

export type GradientTextProps = ComponentPropsWithoutRef<'span'> & {
  /** `accent` is the brand violet→fuchsia plasma · `subtle` is muted indigo→primary. */
  variant?: 'accent' | 'subtle';
};

/**
 * Inline gradient text. Reserve for hero headlines and chromatic moments —
 * never use on body copy.
 */
export function GradientText({ className, variant = 'accent', ...props }: GradientTextProps) {
  return (
    <span
      {...props}
      className={cn(
        'bg-clip-text text-transparent',
        variant === 'accent' && 'bg-gradient-to-r from-primary via-primary to-fuchsia-500',
        variant === 'subtle' && 'bg-gradient-to-r from-primary/80 to-indigo-400',
        className,
      )}
    />
  );
}
