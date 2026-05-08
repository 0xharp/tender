'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

const NATIVE_W = 1200;
const NATIVE_H = 630;

interface OgCardPreviewProps {
  children: ReactNode;
  /** Maximum scale (caps the preview on wide viewports). Default 0.5 → 600x315. */
  maxScale?: number;
}

/**
 * In-page preview of an OG card (lib/og/*). Renders the card at its
 * native 1200x630 inside a CSS-scaled, clipped frame so users can see
 * what their shared link will unfurl as on X / Slack / Discord.
 *
 * The OG card components were authored for `next/og`'s Satori renderer,
 * but Satori is a strict subset of CSS — every style they use is also
 * valid in the browser, so the same component renders identically here.
 *
 * Fluid sizing: the wrapper takes the parent's full width up to
 * `maxScale * 1200` (default 600px), and `aspect-ratio: 1200/630` keeps
 * the box shape correct even before JS measures. A ResizeObserver picks
 * up the rendered width and computes the inner transform scale, so the
 * 1200x630 child fills the visible frame at every viewport — desktop
 * shows the full 600x315; a 360px phone gets ~360x189 with the card
 * scaled down proportionally instead of clipped.
 */
export function OgCardPreview({ children, maxScale = 0.5 }: OgCardPreviewProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Start at maxScale so SSR matches the desktop case. ResizeObserver
  // shrinks it on first commit when the container is narrower; the
  // resulting one-frame flash is just a slightly-too-large card chunk
  // before the scale settles, never the wrong box dimensions (those
  // are locked by aspect-ratio).
  const [scale, setScale] = useState(maxScale);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setScale(Math.min(maxScale, w / NATIVE_W));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxScale]);

  return (
    <div
      ref={wrapperRef}
      className="w-full overflow-hidden rounded-xl border border-border/60 shadow-sm"
      style={{
        maxWidth: Math.round(NATIVE_W * maxScale),
        aspectRatio: `${NATIVE_W} / ${NATIVE_H}`,
      }}
    >
      <div
        style={{
          width: NATIVE_W,
          height: NATIVE_H,
          transformOrigin: 'top left',
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
