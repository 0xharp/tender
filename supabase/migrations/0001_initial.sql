-- Tender — initial schema (Day 4)
--
-- Tables:
--   rfps              public + draft RFP metadata, mirrors on-chain Rfp PDA
--   providers         provider profiles (off-chain because of rich content)
--   reputation_cache  read-model cache for fast UI; canonical source is on-chain
--
-- bid_ciphertexts arrives Day 5. dune_events arrives Day 11.
--
-- RLS policies are defined in 0002_rls.sql once SIWS JWT format is in place.
-- This migration creates schema only; tables start with RLS disabled — apply
-- 0002 immediately after to lock them down.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- providers
-- ---------------------------------------------------------------------------
create table if not exists providers (
  wallet                       text primary key,
  display_name                 text,
  bio                          text,
  categories                   text[] not null default '{}',
  links                        jsonb not null default '{}'::jsonb,
  verification_tier            int not null default 0
                                  check (verification_tier between 0 and 3),
  identity_attestation_uri     text,
  kyb_attestation_uri          text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

create index if not exists providers_categories_gin
  on providers using gin (categories);

-- ---------------------------------------------------------------------------
-- rfps
-- ---------------------------------------------------------------------------
create table if not exists rfps (
  id                           uuid primary key default gen_random_uuid(),
  on_chain_pda                 text unique not null,
  buyer_wallet                 text not null,
  buyer_encryption_pubkey_hex  text not null,
  rfp_nonce_hex                text not null,
  title                        text not null,
  category                     text not null
                                  check (category in (
                                    'audit', 'design', 'engineering', 'legal',
                                    'marketing', 'market_making', 'other'
                                  )),
  scope_summary                text not null,
  scope_detail_encrypted       bytea,
  budget_max_usdc              numeric(20, 6) not null check (budget_max_usdc > 0),
  bid_open_at                  timestamptz not null,
  bid_close_at                 timestamptz not null,
  reveal_close_at              timestamptz not null,
  milestone_template           jsonb not null
                                  check (jsonb_typeof(milestone_template) = 'array'),
  status                       text not null default 'open'
                                  check (status in (
                                    'draft', 'open', 'reveal', 'awarded',
                                    'in_progress', 'completed', 'disputed', 'cancelled'
                                  )),
  winner_wallet                text,
  bid_count                    int not null default 0,
  tx_signature                 text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint rfps_window_order
    check (bid_open_at < bid_close_at and bid_close_at < reveal_close_at)
);

create index if not exists rfps_status_idx on rfps (status, bid_close_at);
create index if not exists rfps_buyer_wallet_idx on rfps (buyer_wallet);
create index if not exists rfps_category_idx on rfps (category);
create index if not exists rfps_created_at_idx on rfps (created_at desc);

-- ---------------------------------------------------------------------------
-- reputation_cache
-- ---------------------------------------------------------------------------
create table if not exists reputation_cache (
  wallet                       text primary key,
  completed_engagements        int not null default 0,
  disputed_engagements         int not null default 0,
  on_time_count                int not null default 0,
  late_count                   int not null default 0,
  total_value_settled_usdc     numeric(20, 6) not null default 0,
  categories                   text[] not null default '{}',
  last_engagement_at           timestamptz,
  last_synced_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at trigger (re-usable)
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists rfps_updated_at on rfps;
create trigger rfps_updated_at
  before update on rfps
  for each row execute function set_updated_at();

drop trigger if exists providers_updated_at on providers;
create trigger providers_updated_at
  before update on providers
  for each row execute function set_updated_at();
