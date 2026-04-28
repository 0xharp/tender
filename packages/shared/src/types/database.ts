/**
 * Postgres schema types — mirrors supabase/migrations/0001_initial.sql.
 *
 * Hand-written rather than auto-generated to keep the package free of a
 * Supabase CLI dependency. When the schema changes, update both this file
 * and the migration in lockstep.
 */

import type { RfpCategory } from '../constants.js';
import type { RfpStatus } from './rfp.js';

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

export interface ProviderRow {
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
}

export type ProviderInsert = Omit<ProviderRow, 'created_at' | 'updated_at'> & {
  created_at?: string;
  updated_at?: string;
};

export type ProviderUpdate = Partial<Omit<ProviderRow, 'wallet' | 'created_at'>>;

// ---------------------------------------------------------------------------
// rfps
// ---------------------------------------------------------------------------

export interface MilestoneTemplateEntry {
  name: string;
  description: string;
  percentage: number;
}

export interface RfpRow {
  id: string;
  on_chain_pda: string;
  buyer_wallet: string;
  buyer_encryption_pubkey_hex: string;
  rfp_nonce_hex: string;
  title: string;
  category: RfpCategory;
  scope_summary: string;
  scope_detail_encrypted: Uint8Array | null;
  budget_max_usdc: string; // numeric → string for precision
  bid_open_at: string;
  bid_close_at: string;
  reveal_close_at: string;
  milestone_template: MilestoneTemplateEntry[];
  status: RfpStatus;
  winner_wallet: string | null;
  bid_count: number;
  tx_signature: string | null;
  created_at: string;
  updated_at: string;
}

export type RfpInsert = Omit<
  RfpRow,
  'id' | 'created_at' | 'updated_at' | 'bid_count' | 'status' | 'winner_wallet'
> & {
  id?: string;
  bid_count?: number;
  status?: RfpStatus;
  winner_wallet?: string | null;
};

export type RfpUpdate = Partial<
  Omit<RfpRow, 'id' | 'on_chain_pda' | 'buyer_wallet' | 'created_at'>
>;

// ---------------------------------------------------------------------------
// reputation_cache
// ---------------------------------------------------------------------------

export interface ReputationCacheRow {
  wallet: string;
  completed_engagements: number;
  disputed_engagements: number;
  on_time_count: number;
  late_count: number;
  total_value_settled_usdc: string;
  categories: RfpCategory[];
  last_engagement_at: string | null;
  last_synced_at: string;
}

// ---------------------------------------------------------------------------
// Database root — feed this to createClient<Database>()
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      providers: {
        Row: ProviderRow;
        Insert: ProviderInsert;
        Update: ProviderUpdate;
      };
      rfps: {
        Row: RfpRow;
        Insert: RfpInsert;
        Update: RfpUpdate;
      };
      reputation_cache: {
        Row: ReputationCacheRow;
        Insert: ReputationCacheRow;
        Update: Partial<Omit<ReputationCacheRow, 'wallet'>>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
