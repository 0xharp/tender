/**
 * Postgres schema types — mirrors supabase/migrations/0001_initial.sql.
 *
 * Uses `type` (not `interface`) throughout so the shapes are structurally
 * compatible with Supabase postgrest's `GenericTable` constraint
 * (`Record<string, unknown>` for Row/Insert/Update). Interfaces would
 * require an explicit index signature.
 */

import type { RfpCategory } from '../constants.js';
import type { BidStorageBackend } from './bid.js';
import type { RfpStatus } from './rfp.js';

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

export type RfpRow = {
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
};

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
// bid_ciphertexts
// ---------------------------------------------------------------------------

export type BidCiphertextRow = {
  id: string;
  on_chain_pda: string;
  rfp_id: string;
  rfp_pda: string;
  provider_wallet: string;
  ciphertext: Uint8Array;
  ephemeral_pubkey_hex: string;
  commit_hash_hex: string;
  storage_backend: BidStorageBackend;
  per_session_id: string | null;
  submitted_at: string;
  // Encrypt-to-both: same plaintext, encrypted to provider's wallet-derived
  // X25519 pubkey. Lets the provider decrypt their own bids back without the
  // buyer. Nullable for legacy rows that pre-date the encrypt-to-both column.
  provider_ciphertext: Uint8Array | null;
  provider_ephemeral_pubkey_hex: string | null;
};

export type BidCiphertextInsert = Omit<BidCiphertextRow, 'id' | 'submitted_at'> & {
  id?: string;
  submitted_at?: string;
};

export type BidCiphertextUpdate = Partial<Omit<BidCiphertextRow, 'id' | 'on_chain_pda'>>;

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
      bid_ciphertexts: {
        Row: BidCiphertextRow;
        Insert: BidCiphertextInsert;
        Update: BidCiphertextUpdate;
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
