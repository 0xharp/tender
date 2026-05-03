/**
 * Postgres schema types — mirrors current state after migration 0006
 * (chain-is-source-of-truth). The `rfps` table holds only the human-readable
 * text fields we never put on-chain; `bid_ciphertexts` no longer exists.
 *
 * Authoritative state for RFP windows, status, bid_count, winner, etc. lives
 * on the on-chain `Rfp` account at `on_chain_pda`. Authoritative state for
 * bids lives on on-chain `BidCommit` accounts queried via getProgramAccounts.
 */

import type { RfpCategory } from '../constants.js';

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

export type ProviderRow = {
  wallet: string;
  display_name: string | null;
  bio: string | null;
  categories: RfpCategory[];
  links: Record<string, string>;
  verification_tier: 0 | 1 | 2 | 3;
  identity_attestation_uri: string | null;
  kyb_attestation_uri: string | null;
  created_at: string;
  updated_at: string;
};

export type ProviderInsert = Omit<ProviderRow, 'created_at' | 'updated_at'> & {
  created_at?: string;
  updated_at?: string;
};

export type ProviderUpdate = Partial<Omit<ProviderRow, 'wallet' | 'created_at'>>;

// ---------------------------------------------------------------------------
// rfps
// ---------------------------------------------------------------------------

/** Per-RFP bidder identity privacy level — see docs/PRIVACY-MODEL.md. Lives
 *  on-chain on the Rfp account; the type is exported here for callers that
 *  decode chain state into TS. */
export type BidderVisibility = 'public' | 'buyer_only';

/**
 * Rfp metadata row (post-migration 0007). The on-chain Rfp account is the
 * source of truth for everything else (status, bid_count, winner, windows,
 * identity, visibility, milestone_count + percentages once awarded).
 *
 * `rfp_nonce_hex` is kept off-chain because the on-chain Rfp account doesn't
 * store the nonce (it only appears in the PDA seed) — and providers need the
 * exact 8 bytes to deterministically derive PDAs.
 *
 * Migration 0007 dropped `milestone_template` (placeholder names that weren't
 * used downstream) and `scope_detail_encrypted` (never wired up — encrypted
 * scope flow was deferred). Milestones now live entirely inside the encrypted
 * winning-bid envelope; on-chain stores count + percentages only.
 */
export type RfpRow = {
  id: string;
  on_chain_pda: string;
  rfp_nonce_hex: string;
  title: string;
  scope_summary: string;
  tx_signature: string | null;
  created_at: string;
  updated_at: string;
};

export type RfpInsert = Omit<RfpRow, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

export type RfpUpdate = Partial<Omit<RfpRow, 'id' | 'on_chain_pda' | 'created_at'>>;

// ---------------------------------------------------------------------------
// bid_ciphertexts
// ---------------------------------------------------------------------------

// `bid_ciphertexts` table dropped in migration 0006. Bids now read directly
// from on-chain BidCommit accounts via getProgramAccounts. The decoded
// BidCommit shape is exported by `@tender/tender-client` (`accounts.BidCommit`).

// ---------------------------------------------------------------------------
// reputation_cache
// ---------------------------------------------------------------------------

export type ReputationCacheRow = {
  wallet: string;
  completed_engagements: number;
  disputed_engagements: number;
  on_time_count: number;
  late_count: number;
  total_value_settled_usdc: string;
  categories: RfpCategory[];
  last_engagement_at: string | null;
  last_synced_at: string;
};

// ---------------------------------------------------------------------------
// milestone_notes (migration 0008)
// ---------------------------------------------------------------------------

/** Off-chain context attached to a milestone state transition. The on-chain
 *  Milestone account is the source of truth for status; this table carries
 *  the human-readable rationale ("here's the link", "section 3 needs work").
 *  Append-only by RLS - notes can't be rewritten after-the-fact. */
export type MilestoneNoteKind =
  | 'submit'
  | 'request_changes'
  | 'reject'
  | 'accept'
  | 'dispute_propose'
  | 'comment';

export type MilestoneNoteRow = {
  id: string;
  rfp_pda: string;
  milestone_index: number;
  author_wallet: string;
  kind: MilestoneNoteKind;
  body: string;
  /** Solana tx signature of the on-chain action this note attaches to.
   *  Nullable for free-form 'comment' notes that aren't tied to a specific tx. */
  tx_signature: string | null;
  created_at: string;
};

export type MilestoneNoteInsert = Omit<MilestoneNoteRow, 'id' | 'created_at'> & {
  id?: string;
  created_at?: string;
};

// ---------------------------------------------------------------------------
// Database root — feed this to createClient<Database>()
// ---------------------------------------------------------------------------

export type Database = {
  public: {
    Tables: {
      providers: {
        Row: ProviderRow;
        Insert: ProviderInsert;
        Update: ProviderUpdate;
        Relationships: [];
      };
      rfps: {
        Row: RfpRow;
        Insert: RfpInsert;
        Update: RfpUpdate;
        Relationships: [];
      };
      reputation_cache: {
        Row: ReputationCacheRow;
        Insert: ReputationCacheRow;
        Update: Partial<Omit<ReputationCacheRow, 'wallet'>>;
        Relationships: [];
      };
      milestone_notes: {
        Row: MilestoneNoteRow;
        Insert: MilestoneNoteInsert;
        // Append-only by RLS. The Update type has no fields, so any
        // attempted .update() call is a typecheck error - matches the
        // database policy.
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
