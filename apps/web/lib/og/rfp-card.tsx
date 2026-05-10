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

/** Bidder visibility — same enum the in-app `PrivacyBadges` consumes.
 *  Buyer visibility is its own dimension (see `buyerVisibility` below). */
export type RfpOgPrivacyMode = 'public' | 'buyer_only';
/** Buyer visibility — independent of bidder visibility in v2. */
export type RfpOgBuyerVisibility = 'public' | 'private';

export interface RfpOgCardProps {
  /** Hero - the RFP's human-readable title from supabase. */
  title: string;
  /** Sub-line - buyer's `.sol` if resolved, else truncated wallet. */
  buyerHandle: string;
  /** Bidder privacy mode - rendered with the same labels + tints as the
   *  in-app `PrivacyBadges` so the OG card and the marketplace cards
   *  describe privacy in the same words. */
  privacyMode: RfpOgPrivacyMode;
  /** Buyer privacy mode - drives the third "Buyer Private" badge. */
  buyerVisibility?: RfpOgBuyerVisibility;
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

// Mirrors `PrivacyBadges` in components/primitives/privacy-tag.tsx —
// three independent badges that stack: bid-content (always),
// bidder (when buyer_only), buyer (when private). Keep tones in sync
// with the in-app component.
type BadgeTone = { fg: string; bg: string; border: string };
const TONE_CONTENT: BadgeTone = {
  fg: '#6EE7A8',
  bg: 'rgba(110, 231, 168, 0.10)',
  border: 'rgba(110, 231, 168, 0.30)',
};
const TONE_BIDDER: BadgeTone = {
  fg: COLORS.primary,
  bg: COLORS.primarySoft,
  border: COLORS.primaryRing,
};
const TONE_BUYER: BadgeTone = {
  fg: '#E879F9',
  bg: 'rgba(232, 121, 249, 0.12)',
  border: 'rgba(232, 121, 249, 0.40)',
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
  buyerVisibility = 'public',
  status,
  stats,
}: RfpOgCardProps): ReactElement {
  const tone = STATUS_TONE[status];
  const showBidderBadge = privacyMode === 'buyer_only';
  const showBuyerBadge = buyerVisibility === 'private';
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
          <svg
            width={56}
            height={56}
            viewBox="0 0 32 32"
            fill="none"
            role="img"
            aria-label="tendr.bid logo"
          >
            {/* No <title> — Satori paints it as visible text on the PNG;
                aria-label gives screen readers the same affordance for
                the in-page preview without leaking onto the rendered image. */}
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
            // 1.05 was too tight for descenders (g, j, p, q, y) on
            // titles whose last line ends in those letters. 1.15 gives
            // the baseline room without visibly shifting the layout.
            lineHeight: 1.15,
            paddingBottom: Math.round(titleSize * 0.05),
            color: COLORS.fg,
            // Cap the title to two visual lines worth of width.
            maxWidth: '95%',
          }}
        >
          {safeTitle}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div
            style={{
              display: 'flex',
              fontSize: 22,
              color: COLORS.fgMuted,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              letterSpacing: '0.02em',
              marginRight: 4,
            }}
          >
            buyer · {buyerHandle}
          </div>
          <PrivacyChip tone={TONE_CONTENT} label="BID CONTENT PRIVATE" />
          {showBidderBadge && <PrivacyChip tone={TONE_BIDDER} label="BIDDER PRIVATE" />}
          {showBuyerBadge && <PrivacyChip tone={TONE_BUYER} label="BUYER PRIVATE" />}
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

function PrivacyChip({ tone, label }: { tone: BadgeTone; label: string }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        padding: '4px 12px',
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        backgroundColor: tone.bg,
        fontSize: 14,
        fontWeight: 500,
        color: tone.fg,
        letterSpacing: '0.14em',
      }}
    >
      {label}
    </div>
  );
}
