import { LockKeyholeIcon, ShieldCheckIcon, UserXIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Three independent privacy dimensions, each rendered as its own badge.
 * "Bid Content Private" is always present (every Tender RFP encrypts bid
 * envelopes); the other two stack on when the corresponding visibility
 * flag is set to private.
 */
export type BidderVisibility = 'public' | 'buyer_only';
export type BuyerVisibility = 'public' | 'private';

/** Backwards-compat alias for call sites that haven't migrated yet. */
export type PrivacyMode = BidderVisibility;

export interface PrivacyBadgesProps {
  bidderVisibility?: BidderVisibility;
  buyerVisibility?: BuyerVisibility;
  size?: 'sm' | 'md';
  /** Override the wrapper className (e.g. to control wrap behavior). */
  className?: string;
}

interface BadgeProps {
  Icon: typeof ShieldCheckIcon;
  label: string;
  tooltip: string;
  size: 'sm' | 'md';
  tone: 'content' | 'bidder' | 'buyer';
}

/**
 * Icon-only round badge with hover tooltip via title attribute. Compacts
 * the stack into a single tight row so the privacy posture is glanceable
 * without dominating the card. The full label + explainer surface on
 * hover. `aria-label` keeps the badge accessible to screen readers.
 */
function Badge({ Icon, label, tooltip, size, tone }: BadgeProps) {
  return (
    <span
      title={`${label} — ${tooltip}`}
      aria-label={`${label}. ${tooltip}`}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border transition-colors',
        size === 'sm' ? 'size-5' : 'size-6',
        tone === 'content' &&
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
        tone === 'bidder' && 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15',
        tone === 'buyer' &&
          'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-600 hover:bg-fuchsia-500/15 dark:text-fuchsia-300',
      )}
    >
      <Icon className={size === 'sm' ? 'size-3' : 'size-3.5'} />
    </span>
  );
}

/**
 * Render the privacy badge stack for an RFP. Always shows
 * "Bid Content Private"; adds "Bidder Private" and/or "Buyer Private"
 * based on the visibility flags. Use this everywhere an RFP's privacy
 * posture surfaces — marketplace cards, detail pages, OG previews.
 */
export function PrivacyBadges({
  bidderVisibility = 'public',
  buyerVisibility = 'public',
  size = 'sm',
  className,
}: PrivacyBadgesProps) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1', className)}>
      <Badge
        Icon={ShieldCheckIcon}
        label="Bid Content Private"
        tooltip="Bid contents (price, scope, milestones) are encrypted on-chain and only revealed at award time."
        size={size}
        tone="content"
      />
      {bidderVisibility === 'buyer_only' && (
        <Badge
          Icon={LockKeyholeIcon}
          label="Bidder Private"
          tooltip="Bidder identities are hidden behind HD-derived ephemeral wallets; the main wallet is only revealed when the provider runs Claim reputation from Dashboard after project completion."
          size={size}
          tone="bidder"
        />
      )}
      {buyerVisibility === 'private' && (
        <Badge
          Icon={UserXIcon}
          label="Buyer Private"
          tooltip="The RFP's buyer is an HD-derived ephemeral wallet — the buyer's main wallet doesn't appear on chain during the lifecycle. Public rep credit only after the buyer runs Claim reputation from Dashboard."
          size={size}
          tone="buyer"
        />
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Legacy single-tag API                                                       */
/* -------------------------------------------------------------------------- */
/* Existing call sites pass a single `mode` (the bidder visibility). Keep the
   old API working as a thin wrapper around the new badge stack so nothing
   breaks while we migrate. New code should prefer `PrivacyBadges` directly. */

export interface PrivacyTagProps {
  mode: PrivacyMode;
  size?: 'sm' | 'md';
  /** Hide the icon - use when stacked next to other pills. (Legacy; ignored
   *  by the new badge renderer.) */
  iconless?: boolean;
  className?: string;
}

export function PrivacyTag({ mode, size = 'sm', className }: PrivacyTagProps) {
  return <PrivacyBadges bidderVisibility={mode} size={size} className={className} />;
}

const SHORT_COPY: Record<PrivacyMode, string> = {
  public: 'Bid contents stay sealed until award. Bidder wallets are public.',
  buyer_only:
    'Bid contents AND bidder identity stay sealed. Bids are signed by HD-derived ephemeral wallets.',
};

export function privacyTagShort(mode: PrivacyMode): string {
  return SHORT_COPY[mode];
}
