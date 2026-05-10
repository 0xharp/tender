'use client';

/**
 * Client-side role gate for the RFP detail page action panels.
 *
 * The server can't tell whether the connected wallet is the HD-buyer
 * for this RFP — `chainRfp.buyer` is an HD ephemeral, not the main
 * wallet. Server-side `isBuyer = wallet === chainRfp.buyer` always
 * resolves to `false` for HD-buyer RFPs, which means BuyerActionPanel
 * never mounts and the user sees the bidder panels instead.
 *
 * This wrapper accepts both candidate slots (buyer + not-buyer) and
 * decides at render time. Resolution sources:
 *   - `serverIsBuyer` — main-wallet match, computed server-side
 *   - HD-buyer match — `useMyActivity().ownedRfps.some(r => r.pda === rfpPda && r.via === 'hd')`
 *
 * Either match → render `buyerSlot`. Else → render `notBuyerSlot`.
 *
 * Why pass JSX as props rather than computing in a child: keeps the
 * server page simple and avoids prop-plumbing the full set of buyer
 * + provider panel props through one more layer.
 */
import type { ReactNode } from 'react';

import { useMyActivity, useTendrAccount } from '@/lib/wallet';

export interface HdRoleSwitchProps {
  rfpPda: string;
  /** Server-resolved `wallet === chainRfp.buyer`. */
  serverIsBuyer: boolean;
  /** Render this when the viewer is the buyer (main OR HD). */
  buyerSlot: ReactNode;
  /** Render this when the viewer is NOT the buyer. */
  notBuyerSlot: ReactNode;
}

export function HdRoleSwitch({
  rfpPda,
  serverIsBuyer,
  buyerSlot,
  notBuyerSlot,
}: HdRoleSwitchProps) {
  const account = useTendrAccount();
  const activity = useMyActivity();
  const isHdBuyer = !!(
    account && activity.ownedRfps.some((r) => r.pda === rfpPda && r.via === 'hd')
  );
  return <>{serverIsBuyer || isHdBuyer ? buyerSlot : notBuyerSlot}</>;
}
