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

export type MilestoneTemplateEntry = {
  name: string;
  description: string;
  percentage: number;
};

/** Per-RFP bidder identity privacy level — see docs/PRIVACY-MODEL.md. Lives
 *  on-chain on the Rfp account; the type is exported here for callers that
 *  decode chain state into TS. */
export type BidderVisibility = 'public' | 'buyer_only';

/**
 * Rfp metadata row (post-migration 0006). The on-chain Rfp account is the
 * source of truth for everything else (status, bid_count, winner, windows,
 * identity, visibility, budget).
 *
 * `rfp_nonce_hex` is kept off-chain because the on-chain Rfp account doesn't
 * store the nonce (it only appears in the PDA seed) — and L1 providers need
 * the exact 8 bytes to deterministically derive their bid_pda_seed.
 */
export type RfpRow = {
  id: string;
  on_chain_pda: string;
  rfp_nonce_hex: string;
  title: string;
  scope_summary: string;
  scope_detail_encrypted: Uint8Array | null;
  milestone_template: MilestoneTemplateEntry[];
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
