'use client';

/**
 * Provider's "discover all my private bids" surface.
 *
 * Closes the v1 UX gap: previously a provider had no way to know which
 * RFPs they'd placed private (buyer_only-mode) bids on without revisiting
 * each RFP and signing to re-derive the per-RFP ephemeral. A fresh device
 * started blind to its own bid history.
 *
 * v2 fix: one master sign (HD-keychain unlock) → derive bidder ephemerals
 * 0..63 in parallel → memcmp scan against `bid.provider` → render every
 * private bid this main wallet has ever placed, in one list, on any device.
 *
 * Mounting note: only mount this on the provider's OWN profile page
 * (`isOwnProfile`). On someone else's profile we can't enumerate their
 * private bids — that's exactly the privacy property we're preserving.
 */
import { ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { LocalTime } from '@/components/local-time';
import { HashLink } from '@/components/primitives/hash-link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type OwnBidHit, enumerateOwnBids } from '@/lib/keychain/enumerate';
import { unixSecondsToIso } from '@/lib/solana/chain-reads';
import { cn } from '@/lib/utils';
import { useKeychainContext, useTendrAccount } from '@/lib/wallet';

interface DiscoveredBidRow {
  bidPda: string;
  rfpPda: string;
  ephemeralPubkey: string;
  index: number;
  submittedAtIso: string;
}

function toRow(hit: OwnBidHit): DiscoveredBidRow {
  return {
    bidPda: hit.bid.address,
    rfpPda: String(hit.bid.data.rfp),
    ephemeralPubkey: hit.ephemeralPubkey,
    index: hit.index,
    submittedAtIso: unixSecondsToIso(hit.bid.data.submittedAt),
  };
}

/**
 * Render the Discover-private-bids card. Self-contained — pulls the
 * wallet account + signMessage hook from context. If no wallet is
 * connected, renders nothing (the parent's `isOwnProfile` gate already
 * means the connected wallet IS the profile, but this guards against
 * mid-render disconnect events).
 *
 * Two-layer split keeps React's hooks-rules happy:
 * - Outer reads `account` from context and short-circuits when null
 * - Inner unconditionally calls the hooks that require the account
 */
export function DiscoverPrivateBids() {
  const account = useTendrAccount();
  // Pull the app-wide keychain (KeychainProvider in app/layout.tsx).
  // Single master sign per session covers all HD-derivation surfaces.
  const keychain = useKeychainContext();
  if (!account || !keychain) return null;
  return <DiscoverPrivateBidsInner walletAddress={account.address} keychain={keychain} />;
}

function DiscoverPrivateBidsInner({
  walletAddress,
  keychain,
}: { walletAddress: string; keychain: import('@/lib/wallet').KeychainHandle }) {
  const [discovered, setDiscovered] = useState<DiscoveredBidRow[] | null>(null);

  // Auto-load when the keychain is unlocked. SIWS pre-warm typically
  // unlocks the keychain at sign-in time; if not, the section just
  // stays hidden — we don't surface a manual unlock CTA.
  useEffect(() => {
    if (!keychain.isUnlocked) return;
    let cancelled = false;
    void (async () => {
      try {
        const masterSeed = await keychain.getMasterSeed(); // silent
        const hits = await enumerateOwnBids(masterSeed);
        if (cancelled) return;
        const rows = hits.map(toRow);
        if (typeof window !== 'undefined') {
          for (const r of rows) {
            try {
              window.localStorage.setItem(
                `tender:bidder-index:${r.rfpPda}:${walletAddress}`,
                String(r.index),
              );
            } catch {
              /* quota — non-fatal */
            }
          }
        }
        setDiscovered(rows);
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keychain, walletAddress]);

  if (!discovered || discovered.length === 0) return null;

  return (
    <Card className="border-primary/30 bg-primary/[0.02]">
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4 text-primary" />
          Your private bids
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            ({discovered.length})
          </span>
        </CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          bidder-private
        </span>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y divide-border/40 rounded-xl border border-border/60">
          {discovered.map((r) => (
            <li key={r.bidPda} className="group">
              <Link
                href={`/rfps/${r.rfpPda}`}
                className={cn(
                  'flex items-center justify-between gap-4 px-4 py-3 transition-colors',
                  'hover:bg-card/60',
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="truncate text-sm font-medium">RFP {r.rfpPda.slice(0, 12)}…</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>
                      bid{' '}
                      <HashLink hash={r.bidPda} kind="account" visibleChars={6} linkable={false} />
                    </span>
                    <span>·</span>
                    <span>
                      submitted <LocalTime iso={r.submittedAtIso} />
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
