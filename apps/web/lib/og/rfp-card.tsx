/**
 * RFP-specific OG composition. Different emphasis from the profile card:
 * the *title* is the hero, not the wallet, since people share RFP links
 * to attract bidders or to point at a specific opportunity. Buyer
 * identity (`.sol` if available) lives in the supporting line below the
 * title; status + headline numbers anchor the bottom rail.
 *
 * Same render constraints as profile-card.tsx (Satori): inline styles,
 * hex/rgba only, every multi-child div needs `display: 'flex'`.
 */
import type { ReactElement } from 'react';

export type RfpOgStatus = 'open' | 'sealed' | 'reveal' | 'awarded' | 'completed' | 'closed';

/** Same enum the in-app `PrivacyTag` consumes - source of truth for the
 *  bid privacy distinction. RFPs themselves are always public; this is
 *  about whether *bid contents* and *bidder identity* are sealed. */
export type RfpOgPrivacyMode = 'public' | 'buyer_only';

export interface RfpOgCardProps {
  /** Hero - the RFP's human-readable title from supabase. */
  title: string;
  /** Sub-line - buyer's `.sol` if resolved, else truncated wallet. */
  buyerHandle: string;
  /** Bid privacy mode - rendered with the same labels + tints as the
   *  in-app `PrivacyTag` so the OG card and the marketplace cards
   *  describe privacy in the same words. */
  privacyMode: RfpOgPrivacyMode;
  /** Status pill text + tone. */
  status: RfpOgStatus;
  /** Three bottom-rail stat cells. */
  stats: Array<{ value: string; label: string }>;
}

const COLORS = {
  bg: '#08080F',
  border: 'rgba(255, 255, 255, 0.08)',
  fg: '#F2F1F5',
  fgMuted: '#A4A1AB',
  fgSubtle: '#5C5A66',
  primary: '#A978EB',
  primarySoft: 'rgba(169, 120, 235, 0.14)',
  primaryRing: 'rgba(169, 120, 235, 0.40)',
} as const;

// Mirrors `PrivacyTag` in components/primitives/privacy-tag.tsx - same
// titles, same tints (emerald for public-bidders, primary for fully
// sealed). Keep these in sync if the in-app component changes.
const PRIVACY_TONE: Record<
  RfpOgPrivacyMode,
  { label: string; fg: string; bg: string; border: string }
> = {
  public: {
    label: 'BID CONTENT PRIVATE',
    fg: '#6EE7A8',
    bg: 'rgba(110, 231, 168, 0.10)',
    border: 'rgba(110, 231, 168, 0.30)',
  },
  buyer_only: {
    label: 'BID CONTENT + IDENTITY PRIVATE',
    fg: COLORS.primary,
    bg: COLORS.primarySoft,
    border: COLORS.primaryRing,
  },
};

// Tone the status pill so a glance distinguishes "open for bids" (live)
// from "completed" (closed) without reading the word. Other tones reuse
// primary so we don't have to maintain a full color system in two places.
const STATUS_TONE: Record<RfpOgStatus, { fg: string; bg: string; border: string; label: string }> =
  {
    open: {
      label: 'OPEN',
      fg: '#7BD891',
      bg: 'rgba(123, 216, 145, 0.14)',
      border: 'rgba(123, 216, 145, 0.40)',
    },
    sealed: {
      label: 'BIDS SEALED',
      fg: COLORS.primary,
      bg: COLORS.primarySoft,
      border: COLORS.primaryRing,
    },
    reveal: {
      label: 'REVEAL WINDOW',
      fg: COLORS.primary,
      bg: COLORS.primarySoft,
      border: COLORS.primaryRing,
    },
    awarded: {
      label: 'AWARDED',
      fg: '#7AB6FB',
      bg: 'rgba(122, 182, 251, 0.14)',
      border: 'rgba(122, 182, 251, 0.40)',
    },
    completed: {
      label: 'COMPLETED',
      fg: COLORS.fgMuted,
      bg: 'rgba(255, 255, 255, 0.06)',
      border: 'rgba(255, 255, 255, 0.18)',
    },
    closed: {
      label: 'CLOSED',
      fg: COLORS.fgMuted,
      bg: 'rgba(255, 255, 255, 0.06)',
      border: 'rgba(255, 255, 255, 0.18)',
    },
  };

export function RfpOgCard({
  title,
  buyerHandle,
  privacyMode,
  status,
  stats,
}: RfpOgCardProps): ReactElement {
  const tone = STATUS_TONE[status];
  const privacy = PRIVACY_TONE[privacyMode];
  // Cap the title length so a runaway-long RFP name doesn't blow out
  // the layout. Satori has no `text-overflow: ellipsis` semantics worth
  // relying on here, so we trim manually.
  const safeTitle = title.length > 90 ? `${title.slice(0, 87)}…` : title;
  const titleSize = safeTitle.length > 60 ? 56 : safeTitle.length > 36 ? 72 : 88;
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: COLORS.bg,
        backgroundImage:
          'radial-gradient(circle at 100% 0%, rgba(169, 120, 235, 0.22), transparent 55%), radial-gradient(circle at 0% 100%, rgba(220, 111, 207, 0.10), transparent 55%)',
        padding: '64px',
        color: COLORS.fg,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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
            border: `1px solid ${tone.border}`,
            backgroundColor: tone.bg,
            color: tone.fg,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: '0.16em',
          }}
        >
          {tone.label}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: 20,
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: titleSize,
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
            color: COLORS.fg,
            // Cap the title to two visual lines worth of width.
            maxWidth: '95%',
          }}
        >
          {safeTitle}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: COLORS.fgMuted,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              letterSpacing: '0.02em',
            }}
          >
            buyer · {buyerHandle}
          </div>
          <div
            style={{
              display: 'flex',
              padding: '4px 12px',
              borderRadius: 999,
              border: `1px solid ${privacy.border}`,
              backgroundColor: privacy.bg,
              fontSize: 14,
              fontWeight: 500,
              color: privacy.fg,
              letterSpacing: '0.14em',
            }}
          >
            {privacy.label}
          </div>
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
          <div key={stat.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
