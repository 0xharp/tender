import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '@/lib/utils';

export type GlassPanelProps = ComponentPropsWithoutRef<'div'> & {
  /** `subtle` for working surfaces · `chromatic` for hero / reveal moments. */
  variant?: 'subtle' | 'chromatic';
  /** Inset padding ring around content. */
  inset?: 'none' | 'sm' | 'md' | 'lg';
};

/**
 * Glass surface with backdrop-blur + theme-aware tinted background. Reserved
 * for hero / landing / decryption-reveal moments per brand.md - do NOT apply
 * to dense working surfaces.
 *
 * Variants:
 * · `subtle` - quiet card glass for marketing trust strips, modals, sheet
 *   panels (default).
 * · `chromatic` - primary-tinted glass with a violet edge glow. Reserve for
 *   hero CTAs and the decryption-reveal hero card.
 */
export function GlassPanel({
  className,
  variant = 'subtle',
  inset = 'md',
  ...props
}: GlassPanelProps) {
  return (
    <div
      {...props}
      className={cn(
        'relative rounded-2xl border backdrop-blur-xl transition-colors',
        variant === 'subtle' && 'border-border/60 bg-card/50',
        variant === 'chromatic' &&
          'border-primary/25 bg-card/60 shadow-[0_0_0_1px_rgba(168,120,235,0.08),0_24px_72px_-24px_rgba(168,120,235,0.45)]',
        inset === 'sm' && 'p-4',
        inset === 'md' && 'p-5',
        inset === 'lg' && 'p-7',
        className,
      )}
    />
  );
}
