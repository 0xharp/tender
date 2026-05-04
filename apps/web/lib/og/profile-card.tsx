/**
 * Shared OG card composition used by both buyer + provider OG routes.
 *
 * Render constraints (Satori):
 *  - every `<div>` with multiple children needs `display: 'flex'`
 *  - no Tailwind classes - inline styles only
 *  - no oklch() - hex/rgba only
 *  - system font is fine, no need to ship a custom font for v1
 *
 * Brand reference: dark surface + subtle plasma gradient corner glow
 * (matches the hero on the landing page) + violet accent on the hero
 * label. Data is shown as cold mono numbers - no emojis, no hype words.
 */
import type { ReactElement } from 'react';

export interface ProfileOgCardProps {
  /** Drives the role chip text + tints. */
  role: 'provider' | 'buyer';
  /** Hero label - `.sol` name if SNS resolves, else truncated pubkey. */
  display: string;
  /** Always-shown supporting line under the hero so viewers can verify the wallet behind a `.sol`. */
  walletShort: string;
  /** Three reputation cards along the bottom rail. */
  stats: Array<{ value: string; label: string }>;
}

const COLORS = {
  bg: '#08080F',
  card: '#101119',
  border: 'rgba(255, 255, 255, 0.08)',
  fg: '#F2F1F5',
  fgMuted: '#A4A1AB',
  fgSubtle: '#5C5A66',
  primary: '#A978EB',
  primarySoft: 'rgba(169, 120, 235, 0.14)',
  primaryRing: 'rgba(169, 120, 235, 0.40)',
} as const;

export function ProfileOgCard({
  role,
  display,
  walletShort,
  stats,
}: ProfileOgCardProps): ReactElement {
  // Pick a font size that lets the longest expected `.sol` name + role
  // word still fit in one line at 1200x630 with 64px padding.
  const heroSize = display.length > 22 ? 80 : display.length > 14 ? 110 : 140;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.bg,
        // Two soft radial glows give the dark canvas the same plasma
        // accent the landing page uses on its hero - cheaper to paint
        // in OG (no animation) but visually consistent.
        backgroundImage:
          'radial-gradient(circle at 100% 0%, rgba(169, 120, 235, 0.22), transparent 55%), radial-gradient(circle at 0% 100%, rgba(220, 111, 207, 0.10), transparent 55%)',
        padding: '64px',
        color: COLORS.fg,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Official tendr.bid mark - same vector as `app/icon.svg` and
              `app/apple-icon.svg`: rounded seal + stylized "t" + offset
              `.bid` dot. Drawn inline so Satori rasterizes it directly
              (no fs read, no data-URL plumbing). Stroke is brand violet;
              the seal background is the page color so the mark reads as
              etched, matching the apple-icon treatment. */}
          <svg width={56} height={56} viewBox="0 0 32 32" fill="none">
            <rect
              x={2.5}
              y={2.5}
              width={27}
              height={27}
              rx={7.5}
              stroke={COLORS.primary}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M14 9 V20 Q14 22 16 22 M9.5 12.5 H18.5"
              stroke={COLORS.primary}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx={22} cy={22} r={1.6} fill={COLORS.primary} />
          </svg>
          <div style={{ display: 'flex', fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>
            tendr.bid
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            padding: '10px 22px',
            borderRadius: 999,
            border: `1px solid ${COLORS.primaryRing}`,
            backgroundColor: COLORS.primarySoft,
            color: COLORS.primary,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
          }}
        >
          {role}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: heroSize,
            fontWeight: 600,
            letterSpacing: '-0.035em',
            lineHeight: 1,
            // Subtle white→violet gradient mirrors the "sealed." hero
            // treatment on the landing page so any tendr OG card
            // reads as one family at a glance.
            background: 'linear-gradient(90deg, #F2F1F5 0%, #C4A6F1 60%, #A978EB 100%)',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          {display}
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 18,
            fontSize: 22,
            color: COLORS.fgMuted,
            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
            letterSpacing: '0.02em',
          }}
        >
          {walletShort}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 56,
          borderTop: `1px solid ${COLORS.border}`,
          paddingTop: 32,
        }}
      >
        {stats.map((stat) => (
          <div
            key={stat.label}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 48,
                fontWeight: 600,
                color: COLORS.fg,
                fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                letterSpacing: '-0.02em',
                lineHeight: 1,
              }}
            >
              {stat.value}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 16,
                color: COLORS.fgMuted,
                textTransform: 'uppercase',
                letterSpacing: '0.16em',
              }}
            >
              {stat.label}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', flex: 1 }} />
        <div
          style={{
            display: 'flex',
            fontSize: 16,
            color: COLORS.fgSubtle,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}
        >
          sealed-bid procurement · solana
        </div>
      </div>
    </div>
  );
}
