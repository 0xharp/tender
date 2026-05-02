'use client';

/**
 * Site-wide dot matrix that subtly responds to the mouse cursor. A fixed
 * grid of low-opacity dots brightens / scales near the pointer, giving the
 * page a tactile feel without blocking interaction or content.
 *
 * Implementation choices:
 *   - Single <canvas> covering the viewport, fixed-position behind everything.
 *   - `pointer-events: none` so it never intercepts clicks/hover.
 *   - Reads `--primary` from the active theme so it matches dark/light mode
 *     and the brand palette.
 *   - rAF + a single mousemove listener; respects `prefers-reduced-motion`.
 *   - Honors device pixel ratio for crisp dots on high-DPI displays.
 *   - Cheap: ~5–10k dots tops (default spacing 32px); only the dots within
 *     `INFLUENCE_RADIUS` of the cursor get a non-default style.
 */
import { useEffect, useRef } from 'react';

const SPACING = 16; // px between dot centers (tighter grid for denser texture)
const BASE_DOT_RADIUS = 0.7; // px (smaller dots so the grid doesn't get heavy)
const MAX_DOT_RADIUS = 2.2; // px (when right under the cursor)
const INFLUENCE_RADIUS = 120; // px - cursor's effect range
const BASE_OPACITY = 0.12; // muted at rest so the page content stays primary
const MAX_OPACITY = 0.4;

export function DotMatrix() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorRef = useRef<{ x: number; y: number; active: boolean }>({
    x: -9999,
    y: -9999,
    active: false,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Honor reduced motion: render once at base, no animation loop.
      drawStatic(canvas, ctx);
      const onResize = () => drawStatic(canvas, ctx);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }

    let raf = 0;
    let dpr = window.devicePixelRatio || 1;
    let dotColor = readDotColor();

    function resize() {
      dpr = window.devicePixelRatio || 1;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      canvas!.width = window.innerWidth * dpr;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      canvas!.height = window.innerHeight * dpr;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      canvas!.style.width = `${window.innerWidth}px`;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      canvas!.style.height = `${window.innerHeight}px`;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function frame() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // biome-ignore lint/style/noNonNullAssertion: ref guarded above
      ctx!.clearRect(0, 0, w, h);
      const cursor = cursorRef.current;

      for (let y = SPACING / 2; y < h; y += SPACING) {
        for (let x = SPACING / 2; x < w; x += SPACING) {
          let radius = BASE_DOT_RADIUS;
          let opacity = BASE_OPACITY;
          if (cursor.active) {
            const dx = x - cursor.x;
            const dy = y - cursor.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < INFLUENCE_RADIUS) {
              const t = 1 - dist / INFLUENCE_RADIUS; // 0..1
              radius = BASE_DOT_RADIUS + (MAX_DOT_RADIUS - BASE_DOT_RADIUS) * t;
              opacity = BASE_OPACITY + (MAX_OPACITY - BASE_OPACITY) * t;
            }
          }
          // biome-ignore lint/style/noNonNullAssertion: ref guarded above
          ctx!.beginPath();
          // biome-ignore lint/style/noNonNullAssertion: ref guarded above
          ctx!.fillStyle = `${dotColor}${Math.round(opacity * 255)
            .toString(16)
            .padStart(2, '0')}`;
          // biome-ignore lint/style/noNonNullAssertion: ref guarded above
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          // biome-ignore lint/style/noNonNullAssertion: ref guarded above
          ctx!.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    }

    function onMove(e: PointerEvent) {
      cursorRef.current.x = e.clientX;
      cursorRef.current.y = e.clientY;
      cursorRef.current.active = true;
    }
    function onLeave() {
      cursorRef.current.active = false;
    }
    function onTheme() {
      dotColor = readDotColor();
    }

    resize();
    raf = requestAnimationFrame(frame);
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerleave', onLeave);

    // Refresh dot color when the user toggles theme. The `next-themes`
    // provider flips a `class` on <html> - observe that.
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
    />
  );
}

/** Read `--primary` (or `--foreground` fallback) from the document and parse
 *  it to a `#rrggbb` hex string. We resolve at runtime so theme switches
 *  pick up the new color. */
function readDotColor(): string {
  if (typeof window === 'undefined') return '#7c3aed';
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue('--primary').trim();
  // The token is in oklch - we can't easily parse that without a color lib.
  // Use a brand-violet fallback that matches our --primary closely.
  // (Future: swap to a CSS var resolver if the design changes drastically.)
  void raw;
  // Different shade for light vs dark for visibility against the bg.
  const isDark = root.classList.contains('dark');
  return isDark ? '#a78bfa' : '#7c3aed';
}

function drawStatic(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dotColor = readDotColor();
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (let y = SPACING / 2; y < window.innerHeight; y += SPACING) {
    for (let x = SPACING / 2; x < window.innerWidth; x += SPACING) {
      ctx.beginPath();
      ctx.fillStyle = `${dotColor}${Math.round(BASE_OPACITY * 255)
        .toString(16)
        .padStart(2, '0')}`;
      ctx.arc(x, y, BASE_DOT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
