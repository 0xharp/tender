'use client';

/**
 * MyActivityProvider — single source of truth for "everything this user
 * is involved in" across both the main wallet AND HD-derived ephemerals.
 *
 * Why this exists: before this provider, every surface (marketplace
 * "mine" badge, your-bid-panel, /me/projects, profile pages, ephemeral
 * sweep panel) ran its own independent enumerate. They each needed the
 * keychain unlocked, each fired their own RPC scans, and several of
 * them rendered nothing if the keychain happened to be locked. The
 * net effect was a fragmented, non-foolproof experience: stranded
 * funds invisible on one page but visible on another, RFPs missing
 * from the buyer's own profile, no "action required" notification
 * for HD-buyer reveal duties, etc.
 *
 * The provider runs ONE enumerate (after the keychain unlocks via
 * SIWS pre-warm or session restore) and exposes the merged view via
 * `useMyActivity()`. All consumers read from this — they no longer
 * need to know about HD enumeration mechanics.
 *
 * Refresh policy: enumerates once per (wallet, keychain-unlock) pair.
 * Consumers can call `refresh()` after any action that mutates the
 * user's state (creating an RFP, placing a bid, sweeping, etc).
 *
 * Failure mode: if enumeration fails (RPC down, etc), `isReady` stays
 * false and consumers fall back to whatever main-wallet data the
 * server-side fetch already provided. We never throw or block the UI.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { Address } from '@solana/kit';

import { enumerateOwnBids, enumerateOwnedRfps } from '@/lib/keychain/enumerate';
import { NO_ACTIVE_MILESTONE, computeNextAction } from '@/lib/me/next-action';
import {
  bidStatusToString,
  bidderVisibilityToString,
  buyerVisibilityToString,
  fetchMilestones,
  fetchRfp,
  listBids,
  listRfps,
  rfpStatusToString,
} from '@/lib/solana/chain-reads';
import { browserSupabase } from '@/lib/supabase/client';
import { useTendrAccount } from './account';
import { useKeychainContext } from './keychain-provider';

/** A single RFP the connected wallet "owns" (created as buyer). */
export interface MyOwnedRfp {
  /** RFP PDA. */
  pda: string;
  /** Resolved on-chain status (e.g. "open", "reveal", "completed"). */
  status: string;
  /** Discovery channel. `main` = on-chain `rfp.buyer` matches the main
   *  wallet directly. `hd` = on-chain `rfp.buyer` is an HD buyer
   *  ephemeral derived from the user's master keychain. */
  via: 'main' | 'hd';
  /** HD index (0..N) when via === 'hd'. Lets consumers re-derive the
   *  ephemeral keypair for sign-as-buyer flows. */
  hdIndex?: number;
  /** When via === 'hd', the ephemeral pubkey that owns the RFP on chain. */
  ephemeralPubkey?: string;
  /** Chain timestamps (Unix ms) — used by the next-action classifier
   *  on /me/projects + the wallet popover badge to decide whether the
   *  buyer must act now (e.g. bid window has elapsed → "Close bidding"). */
  bidCloseAtMs: number;
  revealCloseAtMs: number;
  fundingDeadlineMs: number | null;
  /** Active milestone slot — `255` (NO_ACTIVE_MILESTONE) when no
   *  milestone is in flight. */
  activeMilestoneIndex: number;
  /** Total milestones post-award; 0 pre-award. */
  milestoneCount: number;
  /** On-chain bid count — drives "no bids received" branch in the
   *  classifier when the reveal phase has zero submissions. */
  bidCount: number;
  /** Pre-computed action urgency from the buyer's perspective —
   *  classifier needs the milestones array for funded/inprogress/disputed
   *  RFPs (otherwise it bails to wait/Loading), so we compute once here
   *  during enrichment and stash the result. Mirrors what buying-grid
   *  renders per card. Undefined until enrichment lands. */
  nextActionUrgency?: import('@/lib/me/next-action').NextActionUrgency;
  /** Pre-computed action label paired with `nextActionUrgency`. Stored
   *  here so the grid can render the per-card banner without re-doing
   *  the milestone fetch + computeNextAction work the enrichment
   *  already did. Undefined until enrichment lands. */
  nextActionLabel?: string;
  /** Off-chain title from supabase, lazy-resolved after enumerate so HD
   *  RFPs render with real titles instead of `RFP {pda.slice(0,8)}…`.
   *  Undefined while the supabase fan-out is in flight or if the row
   *  isn't in supabase yet (rare — title is written at create time). */
  title?: string;
  scopeSummary?: string;
  /** v2 — `rfp.buyer_attested` flag from chain. True after the buyer ran
   *  attest_buyer_history to claim this anon RFP into their main wallet
   *  rep. Drives the dashboard buying-tab claim CTA visibility. */
  buyerAttested?: boolean;
  /** v2 — `rfp.bidder_visibility` from chain. Needed by the provider-side
   *  panel to decide whether to route post-award actions through the
   *  bidder eph (private bidder mode) or main wallet (public). */
  bidderVisibility?: 'public' | 'buyer_only';
  /** v2 — `rfp.buyer_visibility` from chain. Stored here so the
   *  rfpDataByPda enrichment cache (also keyed on PDA) can carry it
   *  through to MyOwnBid for HD-bid card rendering. */
  buyerVisibility?: 'public' | 'private';
  /** v2 — whether the RFP carries a sealed reserve commitment. */
  hasReserve?: boolean;
  /** v2 — revealed reserve value in USDC base units (after reveal_reserve). */
  reservePriceRevealed?: bigint;
  /** v2 — `rfp.winner` from chain (= the winning bid's PDA, or null if
   *  no winner selected yet). Used as the canonical winner-check by
   *  the bidding-side loser-gate instead of `bid.status === 'selected'`
   *  — the on-chain program's select_bid sets `rfp.winner = Some(bid)`
   *  but doesn't update bid.status (the bid is still delegated to
   *  MagicBlock PER and can't be mutated from base layer), so winning
   *  bids permanently sit at status='committed'. Comparing against
   *  rfp.winner sidesteps that program-level gap entirely. */
  winnerBidPda?: string | null;
}

/** A single bid the connected wallet placed (as provider). */
export interface MyOwnBid {
  bidPda: string;
  rfpPda: string;
  /** When the bid was committed (ISO string). */
  submittedAtIso: string;
  /** `main` = bid.provider matches the main wallet. `hd` = bid was
   *  signed by an HD bidder ephemeral. */
  via: 'main' | 'hd';
  hdIndex?: number;
  /** When via === 'hd', the ephemeral pubkey that signed the bid. */
  ephemeralPubkey?: string;
  /** RFP-side fields, lazy-fetched after enumerate so consumers
   *  (notably the dashboard tab badge) can compute action urgency for
   *  bids without a per-card chain round-trip. Undefined while the
   *  fan-out is in flight; tab badge falls back to the server-passed
   *  initial count in that window. */
  rfpStatus?: string;
  rfpBidCloseAtMs?: number;
  rfpRevealCloseAtMs?: number;
  rfpFundingDeadlineMs?: number | null;
  rfpActiveMilestoneIndex?: number;
  rfpBidCount?: number;
  /** Pre-computed action urgency from the provider's perspective —
   *  avoids re-running computeNextAction in every consumer AND lets the
   *  enrichment pass the full milestones array (which the badge can't
   *  easily fetch itself). Mirrors what bidding-grid.tsx renders per
   *  card. Undefined until enrichment lands. */
  nextActionUrgency?: import('@/lib/me/next-action').NextActionUrgency;
  /** Pre-computed action label paired with `nextActionUrgency`. Stored
   *  here so the grid can render the per-card banner without re-doing
   *  the milestone fetch + computeNextAction work the enrichment
   *  already did. Undefined until enrichment lands. */
  nextActionLabel?: string;
  /** v2 — `rfp.bidder_visibility` from chain. Drives the provider panel's
   *  "should I sign with bidder eph or main wallet" routing. */
  rfpBidderVisibility?: 'public' | 'buyer_only';
  /** v2 — has the provider already claimed this win into main-wallet rep?
   *
   *  **Source changed**: previously read from `bid.winner_attested` on
   *  chain. After the post-delegation refactor (the bid stays delegated
   *  to MagicBlock PER after select_bid, so the tender program can't
   *  write to it), this flag is now derived from the existence of an
   *  `AttestWinReceipt` PDA at `[b"win_receipt", bid_pda]`. The receipt
   *  is `init`-constrained inside `attest_win`, so its presence is the
   *  canonical "this bid was claimed" signal.
   *
   *  Only resolved for HD bids that won a Completed RFP (the only case
   *  where the claim CTA can appear). Undefined otherwise. */
  winnerAttested?: boolean;
  /** On-chain `BidCommit.status` decoded as a string. Only `'selected'`
   *  bids carry post-award provider obligations (start/submit/dispute/
   *  auto-release a milestone). Without gating on this, every bidder on
   *  a funded RFP — winners AND losers — would see "Start milestone N"
   *  banners and badge bumps because `computeNextAction` only inspects
   *  RFP status + milestones, not which bid actually won. */
  bidStatus?: import('@/lib/solana/chain-reads').BidStatusString;
  /** Off-chain RFP title from supabase, lazy-resolved after enumerate so
   *  HD bids render with their RFP's real title instead of a raw PDA. */
  rfpTitle?: string;
  rfpScopeSummary?: string;
  /** Additional RFP fields propagated through the enrichment fan-out so
   *  the BiddingGrid HD path can build a card without re-fetching the
   *  RFP account. Mirrors how MyOwnedRfp carries everything BuyingGrid
   *  needs — single fetch in MyActivityProvider, consumed everywhere. */
  rfpMilestoneCount?: number;
  rfpBuyerVisibility?: 'public' | 'private';
  rfpHasReserve?: boolean;
  rfpReservePriceRevealed?: bigint;
  /** `rfp.winner` propagated from the bid's RFP. Used by the loser-gate
   *  to determine "is THIS bid the winner?" — `bidPda === rfpWinnerBidPda`
   *  works for every bid (winners + losers alike) regardless of whether
   *  the program ever flips bid.status to Selected (it doesn't today
   *  because the bid stays delegated post-select_bid). */
  rfpWinnerBidPda?: string | null;
}

/** A discovered HD ephemeral wallet (buyer or bidder role). Used by
 *  the global EphemeralBalancePanel to surface stranded funds. */
export interface MyEphemeral {
  pubkey: string;
  role: 'buyer' | 'bidder';
  index: number;
  /** RFP PDA this ephemeral is bound to. */
  rfpPda: string;
}

export interface MyActivity {
  /** Every RFP the user owns — main + HD. Sorted by status urgency
   *  (open before completed) then by PDA for stable rendering. */
  ownedRfps: MyOwnedRfp[];
  /** Every bid the user placed — main + HD. */
  ownBids: MyOwnBid[];
  /** Every HD ephemeral discovered (one per private RFP/bid). */
  ephemerals: MyEphemeral[];
  /** True while the initial enumerate is in flight. Consumers can
   *  show their existing main-wallet data during this window. */
  isLoading: boolean;
  /** True after the first successful enumerate. Stays true on
   *  refresh — the merged data is still valid; only `isLoading`
   *  flips during the refresh. */
  isReady: boolean;
  /** Manually trigger a re-enumerate. Call after actions that
   *  mutate the user's state (create RFP, place bid, sweep). */
  refresh: () => Promise<void>;
}

const EMPTY: MyActivity = {
  ownedRfps: [],
  ownBids: [],
  ephemerals: [],
  isLoading: false,
  isReady: false,
  refresh: async () => {},
};

const MyActivityContext = createContext<MyActivity>(EMPTY);

export function MyActivityProvider({
  children,
  signedInWallet,
}: { children: ReactNode; signedInWallet?: string | null }) {
  const account = useTendrAccount();
  const keychain = useKeychainContext();

  // Initial state stays empty on BOTH server and client first-render —
  // anything else creates an SSR↔client hydration mismatch (server has
  // no localStorage, client does). The cache hydration happens in a
  // useEffect immediately after mount; React fires effects synchronously
  // after commit, so this is still ~one frame, visually instant.
  const [ownedRfps, setOwnedRfps] = useState<MyOwnedRfp[]>([]);
  const [ownBids, setOwnBids] = useState<MyOwnBid[]>([]);
  const [ephemerals, setEphemerals] = useState<MyEphemeral[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);

  // Hydrate from localStorage on mount — keyed on the server-known
  // `signedInWallet`, not `account.address`. The wallet adapter takes
  // ~1s to remount on a fresh tab; if we waited for it the popover
  // badge would flash 0 → 1 → 3. Using signedInWallet means we hydrate
  // before the adapter catches up. The fresh enumerate further down
  // still runs once `account.address` is known and matches.
  useEffect(() => {
    if (typeof window === 'undefined' || !signedInWallet) return;
    const cached = readActivityCache(signedInWallet);
    if (!cached) return;
    setOwnedRfps(cached.ownedRfps);
    setOwnBids(cached.ownBids);
    setEphemerals(cached.ephemerals);
    setIsReady(true);
  }, [signedInWallet]);

  const walletAddr = account?.address;

  // Generation counter so stale enumerate runs don't overwrite fresh
  // results. Race scenario this prevents: enumerate fires when keychain
  // is still locked → starts main-only listRfps/listBids. Mid-flight
  // BroadcastChannel hydrates the keychain → keychain identity flips →
  // useCallback rebuilds → useEffect re-fires enumerate WITH the HD
  // merge. Both enumerates are now in flight. If the older (no HD)
  // resolves last, it overwrites the newer (with HD) — the user sees
  // 1 entry instead of 3 even though the second enumerate succeeded.
  // Generation guard: each enumerate captures its gen at start; on
  // commit, drop the result if a newer gen has started.
  const generationRef = useRef(0);
  /** Last successful enumerate, used to throttle the tab-visibility
   *  re-fetch trigger so alt-tabbing to another app and back doesn't
   *  spam RPCs. */
  const lastEnumerateAtRef = useRef<number>(0);
  /** Mirror state into refs so the enumerate closure can read the
   *  latest committed values when deciding whether to preserve
   *  cached HD entries (see below for why). */
  const ownedRfpsRef = useRef<MyOwnedRfp[]>(ownedRfps);
  const ownBidsRef = useRef<MyOwnBid[]>(ownBids);
  const ephemeralsRef = useRef<MyEphemeral[]>(ephemerals);
  useEffect(() => {
    ownedRfpsRef.current = ownedRfps;
  }, [ownedRfps]);
  useEffect(() => {
    ownBidsRef.current = ownBids;
  }, [ownBids]);
  useEffect(() => {
    ephemeralsRef.current = ephemerals;
  }, [ephemerals]);

  const enumerate = useCallback(async () => {
    if (!walletAddr) return;
    const myGen = ++generationRef.current;
    setIsLoading(true);
    try {
      // Always pull main-wallet activity (cheap memcmp scans against
      // the connected wallet's pubkey). HD enumeration is best-effort
      // and only runs when the keychain is unlocked.
      const [mainRfps, mainBids] = await Promise.all([
        listRfps({ buyer: walletAddr as Address }),
        listBids({ providerWallet: walletAddr as Address }),
      ]);

      const merged: { rfps: MyOwnedRfp[]; bids: MyOwnBid[]; eph: MyEphemeral[] } = {
        rfps: mainRfps.map((r) => ({
          pda: String(r.address),
          status: rfpStatusToString(r.data.status),
          via: 'main' as const,
          bidCloseAtMs: Number(r.data.bidCloseAt) * 1000,
          revealCloseAtMs: Number(r.data.revealCloseAt) * 1000,
          fundingDeadlineMs:
            r.data.fundingDeadline > 0n ? Number(r.data.fundingDeadline) * 1000 : null,
          activeMilestoneIndex: r.data.activeMilestoneIndex,
          milestoneCount: r.data.milestoneCount,
          bidCount: r.data.bidCount,
          buyerAttested: r.data.buyerAttested,
          bidderVisibility: bidderVisibilityToString(r.data.bidderVisibility),
          buyerVisibility: buyerVisibilityToString(r.data.buyerVisibility),
          hasReserve: !r.data.reservePriceCommitment.every((b: number) => b === 0),
          reservePriceRevealed: r.data.reservePriceRevealed,
          // Option<Pubkey> from @solana/options is NOT a JS nullable —
          // it's `{ __option: 'Some', value: Address } | { __option: 'None' }`.
          // String(option) returns "[object Object]", which is what was
          // breaking the loser-gate (winnerBidPda was always garbage,
          // so `winnerBidPda !== bidPda` was always true → every
          // winner flipped to "Not selected"). Unwrap explicitly.
          winnerBidPda: r.data.winner?.__option === 'Some' ? String(r.data.winner.value) : null,
        })),
        bids: mainBids.map((b) => ({
          bidPda: String(b.address),
          rfpPda: String(b.data.rfp),
          submittedAtIso: new Date(Number(b.data.submittedAt) * 1000).toISOString(),
          via: 'main' as const,
          // `winnerAttested` is resolved later via the claim-receipt PDA
          // fan-out — `bid.data.winnerAttested` is no longer the source
          // of truth (post-delegation refactor; see field doc).
          bidStatus: bidStatusToString(b.data.status),
        })),
        eph: [],
      };

      // Track whether HD enumerate actually ran. When it did NOT (keychain
      // locked), we fold cached HD entries into merged.* BEFORE enrichment
      // so they get fresh `nextActionUrgency` based on current chain state
      // — see the post-enumerate cached-splice block below. Without that,
      // cached HD bids would carry over a stale urgency from a previous
      // session (e.g. a winning bid whose milestone has long since been
      // started would still report "Start milestone N" forever) and the
      // dashboard tab pip would diverge from the wallet pill.
      let didHdEnumerate = false;
      if (keychain?.isUnlocked) {
        try {
          const masterSeed = await keychain.getMasterSeed();
          const [hdRfps, hdBids] = await Promise.all([
            enumerateOwnedRfps(masterSeed),
            enumerateOwnBids(masterSeed),
          ]);
          didHdEnumerate = true;
          // Dedupe HD against main: if the same RFP shows up under
          // both (shouldn't, but defensive), prefer the main entry.
          const mainRfpSet = new Set(merged.rfps.map((r) => r.pda));
          for (const h of hdRfps) {
            const pda = String(h.rfp.address);
            if (mainRfpSet.has(pda)) continue;
            merged.rfps.push({
              pda,
              status: rfpStatusToString(h.rfp.data.status),
              via: 'hd',
              hdIndex: h.index,
              ephemeralPubkey: String(h.ephemeralPubkey),
              bidCloseAtMs: Number(h.rfp.data.bidCloseAt) * 1000,
              revealCloseAtMs: Number(h.rfp.data.revealCloseAt) * 1000,
              fundingDeadlineMs:
                h.rfp.data.fundingDeadline > 0n ? Number(h.rfp.data.fundingDeadline) * 1000 : null,
              activeMilestoneIndex: h.rfp.data.activeMilestoneIndex,
              milestoneCount: h.rfp.data.milestoneCount,
              bidCount: h.rfp.data.bidCount,
              buyerAttested: h.rfp.data.buyerAttested,
              bidderVisibility: bidderVisibilityToString(h.rfp.data.bidderVisibility),
              buyerVisibility: buyerVisibilityToString(h.rfp.data.buyerVisibility),
              hasReserve: !h.rfp.data.reservePriceCommitment.every((b: number) => b === 0),
              reservePriceRevealed: h.rfp.data.reservePriceRevealed,
              winnerBidPda:
                h.rfp.data.winner?.__option === 'Some' ? String(h.rfp.data.winner.value) : null,
            });
            merged.eph.push({
              pubkey: String(h.ephemeralPubkey),
              role: 'buyer',
              index: h.index,
              rfpPda: pda,
            });
          }
          const mainBidSet = new Set(merged.bids.map((b) => b.bidPda));
          for (const h of hdBids) {
            const bidPda = String(h.bid.address);
            if (mainBidSet.has(bidPda)) continue;
            merged.bids.push({
              bidPda,
              rfpPda: String(h.bid.data.rfp),
              submittedAtIso: new Date(Number(h.bid.data.submittedAt) * 1000).toISOString(),
              via: 'hd',
              hdIndex: h.index,
              ephemeralPubkey: String(h.ephemeralPubkey),
              // Same — resolved via claim-receipt PDA fan-out below.
              bidStatus: bidStatusToString(h.bid.data.status),
            });
            merged.eph.push({
              pubkey: String(h.ephemeralPubkey),
              role: 'bidder',
              index: h.index,
              rfpPda: String(h.bid.data.rfp),
            });
          }
        } catch {
          // HD enumerate failure is non-fatal — main-wallet data still
          // lands. Common causes: user dismissed master sign, RPC hiccup.
        }
      }

      // Cached-HD splice (keychain locked path). When HD didn't run we
      // fold the previously-cached HD entries into `merged.*` BEFORE
      // enrichment — that way they get a fresh nextActionUrgency from
      // current on-chain state instead of carrying the stale value the
      // last session persisted. The dedupe set covers the (rare) case
      // where a cached HD bid's PDA somehow collides with a fresh main
      // bid; main always wins. Same shape for ownedRfps + ephemerals.
      if (!didHdEnumerate) {
        const mainBidPdas = new Set(merged.bids.map((b) => b.bidPda));
        for (const cached of ownBidsRef.current) {
          if (cached.via !== 'hd') continue;
          if (mainBidPdas.has(cached.bidPda)) continue;
          merged.bids.push(cached);
        }
        const mainRfpPdas = new Set(merged.rfps.map((r) => r.pda));
        for (const cached of ownedRfpsRef.current) {
          if (cached.via !== 'hd') continue;
          if (mainRfpPdas.has(cached.pda)) continue;
          merged.rfps.push(cached);
        }
        // Ephemerals are 1:1 with HD entries — preserve them too. They
        // have no enrichment fields so a straight copy is correct.
        merged.eph = ephemeralsRef.current.slice();
      }

      // Enrich bids with their RFP's status + chain timestamps so the
      // dashboard tab badge can compute action urgency for bids the
      // same way it does for RFPs (without a per-card chain fetch from
      // the badge's own context). Reuse already-fetched RFPs from
      // `merged.rfps` (no double-fetch when the user owns + bid on the
      // same RFP, rare but possible). Fetch the rest in one parallel
      // pass — bounded by unique RFPs the user has bid on, typically
      // small. Skipped silently if any single fetch fails — the bid
      // still lands without RFP fields and the badge falls back to the
      // server-passed initial.
      const rfpDataByPda = new Map<string, (typeof merged.rfps)[number]>();
      for (const r of merged.rfps) rfpDataByPda.set(r.pda, r);
      const bidRfpPdasToFetch = Array.from(
        new Set(merged.bids.map((b) => b.rfpPda).filter((pda) => !rfpDataByPda.has(pda))),
      );
      if (bidRfpPdasToFetch.length > 0) {
        const fetched = await Promise.all(
          bidRfpPdasToFetch.map(async (pda) => {
            try {
              const r = await fetchRfp(pda as Address);
              if (!r) return null;
              return [pda, r] as const;
            } catch {
              return null;
            }
          }),
        );
        for (const entry of fetched) {
          if (!entry) continue;
          const [pda, r] = entry;
          rfpDataByPda.set(pda, {
            pda,
            status: rfpStatusToString(r.status),
            via: 'main',
            bidCloseAtMs: Number(r.bidCloseAt) * 1000,
            revealCloseAtMs: Number(r.revealCloseAt) * 1000,
            fundingDeadlineMs: r.fundingDeadline > 0n ? Number(r.fundingDeadline) * 1000 : null,
            activeMilestoneIndex: r.activeMilestoneIndex,
            milestoneCount: r.milestoneCount,
            bidCount: r.bidCount,
            buyerAttested: r.buyerAttested,
            bidderVisibility: bidderVisibilityToString(r.bidderVisibility),
            buyerVisibility: buyerVisibilityToString(r.buyerVisibility),
            hasReserve: !r.reservePriceCommitment.every((b: number) => b === 0),
            reservePriceRevealed: r.reservePriceRevealed,
            winnerBidPda: r.winner?.__option === 'Some' ? String(r.winner.value) : null,
          });
        }
      }
      // For funded/inprogress/disputed RFPs both the buyer + provider
      // classifiers need the milestones array (otherwise they bail to
      // urgency='wait' / "Loading…" and "Review milestone N" / "Start
      // milestone N" never surface). Fetch in parallel for unique RFPs
      // touched by either owned-RFPs OR bids that are in flight.
      const NEEDS_MILESTONES = new Set(['funded', 'inprogress', 'disputed']);
      const milestonesByPda = new Map<string, Awaited<ReturnType<typeof fetchMilestones>>>();
      const ownedRfpsNeedingMs = merged.rfps
        .filter((r) => NEEDS_MILESTONES.has(r.status) && r.milestoneCount > 0)
        .map((r) => r.pda);
      const bidRfpsNeedingMs = merged.bids
        .map((b) => rfpDataByPda.get(b.rfpPda))
        .filter((rd): rd is NonNullable<typeof rd> => !!rd)
        .filter((rd) => NEEDS_MILESTONES.has(rd.status) && rd.milestoneCount > 0)
        .map((rd) => rd.pda);
      const allRfpsNeedingMs = Array.from(new Set([...ownedRfpsNeedingMs, ...bidRfpsNeedingMs]));
      if (allRfpsNeedingMs.length > 0) {
        await Promise.all(
          allRfpsNeedingMs.map(async (pda) => {
            try {
              // Prefer enriched data from rfpDataByPda (covers bid-side
              // RFPs); fall back to merged.rfps (covers owned-only).
              const rd = rfpDataByPda.get(pda) ?? merged.rfps.find((r) => r.pda === pda);
              if (!rd) return;
              const ms = await fetchMilestones(pda as Address, rd.milestoneCount);
              milestonesByPda.set(pda, ms);
            } catch {
              /* best-effort */
            }
          }),
        );
      }
      const nowForUrgency = Date.now();
      merged.rfps = merged.rfps.map((r) => {
        const ms = milestonesByPda.get(r.pda) ?? [];
        const action = computeNextAction({
          role: 'buyer',
          status: r.status,
          activeMilestoneIndex: r.activeMilestoneIndex ?? NO_ACTIVE_MILESTONE,
          milestones: ms,
          bidCloseAtMs: r.bidCloseAtMs,
          revealCloseAtMs: r.revealCloseAtMs,
          fundingDeadlineMs: r.fundingDeadlineMs,
          nowMs: nowForUrgency,
          bidCount: r.bidCount,
        });
        return { ...r, nextActionUrgency: action.urgency, nextActionLabel: action.label };
      });
      merged.bids = merged.bids.map((b) => {
        const rd = rfpDataByPda.get(b.rfpPda);
        if (!rd) return b;
        const ms = milestonesByPda.get(b.rfpPda) ?? [];
        const action = computeNextAction({
          role: 'provider',
          status: rd.status,
          activeMilestoneIndex: rd.activeMilestoneIndex ?? NO_ACTIVE_MILESTONE,
          milestones: ms,
          bidCloseAtMs: rd.bidCloseAtMs,
          revealCloseAtMs: rd.revealCloseAtMs,
          fundingDeadlineMs: rd.fundingDeadlineMs,
          nowMs: nowForUrgency,
          bidCount: rd.bidCount,
        });
        // Gate provider-role urgency on selection. `computeNextAction`
        // for role='provider' only inspects RFP status + milestones, so
        // every bidder on a funded RFP — winners AND losers — would
        // otherwise inherit "Start milestone N" urgency.
        //
        // Winner check: `b.bidPda === rd.winnerBidPda` (compared against
        // `rfp.winner` from chain). NOT `bid.status === Selected` —
        // the on-chain `select_bid` ix never writes BidStatus::Selected
        // because the bid is delegated to MagicBlock PER and can't be
        // mutated from base layer. Winning bids stay at status='committed'
        // forever; checking against `rfp.winner` (which IS set by
        // select_bid as `Some(bid.key())`) avoids that program-level
        // gap entirely. Pre-award statuses skip the gate so all bidders
        // see the right pre-award urgency.
        const POST_AWARD = new Set(['awarded', 'funded', 'inprogress', 'disputed', 'completed']);
        // Loser if winner is decided AND it's not us. When `winnerBidPda`
        // is null/undefined the winner isn't set yet — fall through to
        // the computed urgency rather than under-reporting a real
        // winner's action because the cache hadn't enriched yet.
        const knownLoser = rd.winnerBidPda != null && rd.winnerBidPda !== b.bidPda;
        const urgency = POST_AWARD.has(rd.status) && knownLoser ? 'wait' : action.urgency;
        return {
          ...b,
          rfpStatus: rd.status,
          rfpBidCloseAtMs: rd.bidCloseAtMs,
          rfpRevealCloseAtMs: rd.revealCloseAtMs,
          rfpFundingDeadlineMs: rd.fundingDeadlineMs,
          rfpActiveMilestoneIndex: rd.activeMilestoneIndex,
          rfpBidCount: rd.bidCount,
          rfpBidderVisibility: rd.bidderVisibility,
          rfpMilestoneCount: rd.milestoneCount,
          rfpBuyerVisibility: rd.buyerVisibility,
          rfpHasReserve: rd.hasReserve,
          rfpReservePriceRevealed: rd.reservePriceRevealed,
          rfpWinnerBidPda: rd.winnerBidPda,
          nextActionUrgency: urgency,
          // Loser-gated label: kept in sync with the urgency switch
          // above + the server-side gate in bidding/page.tsx. Branches
          // on bidStatus only for the cosmetic withdrawn/expired
          // distinction (those are correctly written by withdraw_bid /
          // by chain on expiry); the winner determination itself uses
          // rfp.winner per the comment above.
          nextActionLabel:
            POST_AWARD.has(rd.status) && knownLoser
              ? b.bidStatus === 'withdrawn'
                ? 'You withdrew this bid'
                : b.bidStatus === 'expired'
                  ? 'Bid expired'
                  : 'Not selected'
              : action.label,
        };
      });

      // Claim-receipt fan-out — for each bid that won a Completed RFP,
      // check whether an `AttestWinReceipt` PDA exists at
      // `[b"win_receipt", bid_pda]`. Existence == the provider already
      // ran attest_win to merge this bid's eph rep into their main rep.
      //
      // Why we need this: `bid.winnerAttested` on chain stays false
      // forever now (the bid stays delegated post-select_bid; the tender
      // program can't write to it). The receipt PDA — which IS owned by
      // tender — became the source of truth. Drives whether the
      // dashboard bidding-tab shows a "Claim reputation" CTA on a card.
      //
      // Cheap by construction: only fired for bids that are post-award
      // winners on completed RFPs (a small subset of total bids), and
      // batched into one `getMultipleAccounts` call. The `findClaimReceiptPda`
      // helper + `getAccountInfo`-style batch read are dynamically
      // imported so this code path doesn't bloat the cold-load chunk.
      const winningCompletedBids = merged.bids.filter(
        (b) => b.rfpStatus === 'completed' && b.rfpWinnerBidPda === b.bidPda,
      );
      if (winningCompletedBids.length > 0) {
        try {
          const [{ pdas }, kit, { rpc }] = await Promise.all([
            import('@tender/tender-client'),
            import('@solana/kit'),
            import('@/lib/solana/client'),
          ]);
          const receiptPdas = await Promise.all(
            winningCompletedBids.map(async (b) => {
              const [pda] = await pdas.findClaimReceiptPda({ bid: b.bidPda as Address });
              return { bidPda: b.bidPda, receiptPda: String(pda) };
            }),
          );
          // One batched RPC for the whole set — avoids N round-trips.
          const { value: infos } = await rpc
            .getMultipleAccounts(
              // biome-ignore lint/suspicious/noExplicitAny: kit Address branding
              receiptPdas.map((r) => r.receiptPda as any),
              { encoding: 'base64' },
            )
            .send();
          const attestedBidPdas = new Set<string>();
          receiptPdas.forEach((r, i) => {
            if (infos[i]) attestedBidPdas.add(r.bidPda);
          });
          if (attestedBidPdas.size > 0) {
            merged.bids = merged.bids.map((b) =>
              attestedBidPdas.has(b.bidPda) ? { ...b, winnerAttested: true } : b,
            );
          }
          // Reference kit to silence unused-import lint — currently only
          // used implicitly via the rpc client's branding. Kept in the
          // dynamic import list for symmetry with sibling fan-outs (and
          // in case we later need explicit address encoders here).
          void kit;
        } catch {
          // Best-effort — falling back to undefined means the CTA stays
          // visible (worst case: user sees the button after already
          // claiming and the second click hits AccountAlreadyInUse,
          // which the toast surfaces clearly).
        }
      }

      // Off-chain title fan-out — supabase row per RFP carries the
      // human-readable title + scope_summary that users actually want
      // to see (chain only stores a sha256 commitment of the title).
      // Without this, HD-owned RFPs render as `RFP {pda.slice(0,8)}…`
      // because the server-side supabase fetch only covered main-wallet
      // PDAs. One batched `in()` query keyed on PDAs of unique RFPs
      // touched by either the rfps or bids list. Non-fatal on error.
      const allTitlePdas = Array.from(
        new Set([...merged.rfps.map((r) => r.pda), ...merged.bids.map((b) => b.rfpPda)]),
      );
      if (allTitlePdas.length > 0) {
        try {
          const supabase = browserSupabase();
          const { data: titleRows } = await supabase
            .from('rfps')
            .select('on_chain_pda, title, scope_summary')
            .in('on_chain_pda', allTitlePdas);
          if (titleRows) {
            const titleByPda = new Map<string, { title: string; scope_summary: string | null }>();
            for (const row of titleRows) {
              titleByPda.set(row.on_chain_pda, {
                title: row.title,
                scope_summary: row.scope_summary,
              });
            }
            merged.rfps = merged.rfps.map((r) => {
              const t = titleByPda.get(r.pda);
              if (!t) return r;
              return { ...r, title: t.title, scopeSummary: t.scope_summary ?? undefined };
            });
            merged.bids = merged.bids.map((b) => {
              const t = titleByPda.get(b.rfpPda);
              if (!t) return b;
              return { ...b, rfpTitle: t.title, rfpScopeSummary: t.scope_summary ?? undefined };
            });
          }
        } catch {
          // supabase error → fall back to raw PDA labels in consumers.
        }
      }

      // Drop stale results — only the latest enumerate gets to write.
      if (myGen !== generationRef.current) return;

      // Cached HD entries (when keychain stayed locked) were already
      // folded into `merged.*` above the enrichment block, so they
      // carry fresh nextActionUrgency now. Just commit `merged.*` as
      // the final state — no separate splice needed at this point.
      const finalRfps = merged.rfps;
      const finalBids = merged.bids;
      const finalEph = merged.eph;

      setOwnedRfps(finalRfps);
      setOwnBids(finalBids);
      setEphemerals(finalEph);
      setIsReady(true);
      // Persist for the next page-load — instant initial render.
      writeActivityCache(walletAddr, {
        ownedRfps: finalRfps,
        ownBids: finalBids,
        ephemerals: finalEph,
      });
      lastEnumerateAtRef.current = Date.now();
    } finally {
      // Only clear the loading flag if we're still the latest — a
      // newer enumerate may still be in flight.
      if (myGen === generationRef.current) setIsLoading(false);
    }
  }, [walletAddr, keychain]);

  // Auto-run after wallet connects (always — main-wallet data lands
  // immediately) and re-run when `enumerate` rebuilds (which it does
  // when keychain transitions locked → unlocked, since the keychain
  // handle's identity changes at that point).
  useEffect(() => {
    if (!walletAddr) {
      setOwnedRfps([]);
      setOwnBids([]);
      setEphemerals([]);
      setIsReady(false);
      return;
    }
    void enumerate();
  }, [walletAddr, enumerate]);

  // Tab-visibility refresh: when the user comes back from another tab
  // OR another app (alt-tab to IDE, etc), re-enumerate IF the last
  // fetch is meaningfully old. The 30s threshold matches the polling
  // window for action-count and avoids RPC spam during quick window
  // switches — alt-tabbing to look up a value in IntelliJ shouldn't
  // trigger a full re-enumerate every time. The mutation event
  // (`triggerActivityRefresh`) bypasses this throttle so anything
  // the user does in-app gets reflected immediately.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const VISIBILITY_REFRESH_MIN_AGE_MS = 30_000;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!walletAddr) return;
      const ageMs = Date.now() - lastEnumerateAtRef.current;
      if (ageMs < VISIBILITY_REFRESH_MIN_AGE_MS) return;
      void enumerate();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [walletAddr, enumerate]);

  // Custom-event refresh: any in-tab flow that mutates the user's
  // state (create RFP, place bid, sweep, attest, fund, etc) can fire
  // `triggerActivityRefresh()` after its tx confirms and the merged
  // view will re-enumerate without anyone needing the activity ref
  // through props or context.
  useEffect(() => {
    if (typeof window === 'undefined' || !walletAddr) return;
    const onRefresh = () => {
      void enumerate();
    };
    window.addEventListener(ACTIVITY_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ACTIVITY_REFRESH_EVENT, onRefresh);
  }, [walletAddr, enumerate]);

  const value = useMemo<MyActivity>(
    () => ({ ownedRfps, ownBids, ephemerals, isLoading, isReady, refresh: enumerate }),
    [ownedRfps, ownBids, ephemerals, isLoading, isReady, enumerate],
  );

  return <MyActivityContext.Provider value={value}>{children}</MyActivityContext.Provider>;
}

/** Read the merged "everything I'm involved in" view. Always returns
 *  a valid object (never throws / never null) so consumers can call
 *  unconditionally and gate on `isReady` if they need to. */
export function useMyActivity(): MyActivity {
  return useContext(MyActivityContext);
}

/** Event name the provider listens on. Don't import directly —
 *  use `triggerActivityRefresh()`. */
const ACTIVITY_REFRESH_EVENT = 'tender:refresh-activity';

/* -------------------------------------------------------------------------- */
/* localStorage cache — instant initial render                                 */
/* -------------------------------------------------------------------------- */
/* Snapshot persists per wallet so a returning user lands with the right
   popover badge + project counts immediately, without waiting for the fresh
   enumerate. The fresh enumerate still runs in the background; if anything
   has changed it overwrites the cache. Sign-out wipes this so a different
   wallet doesn't accidentally see prior data.                                  */

const ACTIVITY_CACHE_KEY = (wallet: string) => `tender:my-activity:${wallet}`;
/** Bump if the cached shape changes incompatibly. We treat any mismatch as
 *  cache miss — caller falls through to fresh enumerate. */
// Bump when the cached snapshot shape changes (new field on MyOwnedRfp /
// MyOwnBid / MyEphemeral, OR a meaningful change to how enrichment
// computes `nextActionUrgency`). Old caches are silently discarded.
//   v2: added `bidStatus` + `winnerAttested` + the loser-gate semantic
//       to nextActionUrgency.
//   v3: added rfpMilestoneCount / rfpBuyerVisibility / rfpHasReserve /
//       rfpReservePriceRevealed on MyOwnBid + buyerVisibility /
//       hasReserve / reservePriceRevealed on MyOwnedRfp so the
//       BiddingGrid HD path can build a card from MyActivity alone
//       (mirrors the buyer-side architecture).
//   v4: added nextActionLabel alongside nextActionUrgency on both
//       MyOwnedRfp and MyOwnBid so consumers can render the per-card
//       action banner without re-doing the milestone fetch +
//       computeNextAction work the enrichment already did.
//   v5: added winnerBidPda on MyOwnedRfp + rfpWinnerBidPda on MyOwnBid.
//       Loser-gate switched from bidStatus check to rfp.winner check
//       to work around the on-chain gap where select_bid never sets
//       BidStatus::Selected (bid stays delegated to PER, can't be
//       mutated from base layer).
//   v6: fixed winnerBidPda extraction. Option<Pubkey> from @solana/options
//       is `{ __option: 'Some', value } | { __option: 'None' }`, NOT a
//       JS nullable. v5 caches stored `String(option)` which produces
//       "[object Object]" — the loser-gate then never matched and
//       flipped every winner to "Not selected". v6 unwraps via
//       `option.__option === 'Some' ? String(option.value) : null`.
//   v7: `winnerAttested` on MyOwnBid is now resolved from claim-receipt
//       PDA existence instead of the on-chain `bid.winnerAttested` flag
//       (which stays false forever post-delegation refactor — bid is
//       delegated to PER after select_bid, tender program can't write
//       to it). v6 caches that read the stale flag would always show
//       the claim CTA even after a successful claim; v7 reads via
//       `findClaimReceiptPda` + getMultipleAccounts.
const CACHE_VERSION = 7;

interface CachedActivity {
  v: number;
  ownedRfps: MyOwnedRfp[];
  ownBids: MyOwnBid[];
  ephemerals: MyEphemeral[];
}

function readActivityCache(
  wallet: string,
): { ownedRfps: MyOwnedRfp[]; ownBids: MyOwnBid[]; ephemerals: MyEphemeral[] } | null {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_CACHE_KEY(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedActivity;
    if (parsed.v !== CACHE_VERSION) return null;
    if (!Array.isArray(parsed.ownedRfps) || !Array.isArray(parsed.ownBids)) return null;
    return {
      ownedRfps: parsed.ownedRfps,
      ownBids: parsed.ownBids,
      ephemerals: parsed.ephemerals ?? [],
    };
  } catch {
    return null;
  }
}

function writeActivityCache(
  wallet: string,
  snapshot: { ownedRfps: MyOwnedRfp[]; ownBids: MyOwnBid[]; ephemerals: MyEphemeral[] },
): void {
  if (typeof window === 'undefined') return;
  try {
    const cached: CachedActivity = { v: CACHE_VERSION, ...snapshot };
    window.localStorage.setItem(ACTIVITY_CACHE_KEY(wallet), JSON.stringify(cached));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/** Wipe the cache for one wallet (called by SignOutItem). */
export function clearMyActivityCache(wallet?: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (wallet) {
      window.localStorage.removeItem(ACTIVITY_CACHE_KEY(wallet));
      return;
    }
    // Wallet unknown (e.g. sign-out wipe) — remove all keys with our prefix.
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith('tender:my-activity:')) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* private mode — non-fatal */
  }
}

/**
 * Trigger a re-enumerate of MyActivity from anywhere — no need to
 * thread `useMyActivity().refresh` through props. Call after any tx
 * that mutates the user's state: create RFP, place bid, sweep, attest,
 * fund, milestone settle, etc. Idempotent + cheap (debounce isn't
 * necessary; the underlying enumerate runs in <1s and consumers
 * already memo their reads).
 */
export function triggerActivityRefresh(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT));
}
