-- Tender — chain-is-source-of-truth (Day 6.5)
--
-- Drops every column from `rfps` that's already on the on-chain Rfp account,
-- and removes the entire `bid_ciphertexts` table (bids now read directly from
-- the on-chain BidCommit accounts via getProgramAccounts).
--
-- What stays in supabase: only the human-readable text we never put on-chain
-- (title, scope_summary, milestone_template, scope_detail_encrypted) plus the
-- on_chain_pda foreign key for joins.
--
-- Why: every previous attempt to "mirror on-chain state to supabase for fast
-- reads" eventually drifted. The bid_count divergence after the failed
-- Magic Action close was the trigger — but the underlying problem is that
-- writes to the chain happen in many places (user txs, ER seal-backs, magic
-- actions) and Supabase mirror writes only happen in ONE of those (our API
-- handlers). The mirror is structurally lossy. Reading from chain is the
-- only consistent option.
--
-- Migration is destructive — column drops can't be reversed once data is gone.
-- Devnet only; mainnet would need a different strategy.

-- ---------------------------------------------------------------------------
-- bid_ciphertexts — drop entirely
-- ---------------------------------------------------------------------------
drop policy if exists bid_ciphertexts_public_read on bid_ciphertexts;
drop policy if exists bid_ciphertexts_provider_insert on bid_ciphertexts;
drop policy if exists bid_ciphertexts_provider_delete on bid_ciphertexts;

drop index if exists bid_ciphertexts_rfp_id_idx;
drop index if exists bid_ciphertexts_provider_wallet_idx;
drop index if exists bid_ciphertexts_commit_hash_idx;
drop index if exists bid_ciphertexts_provider_wallet_hash_idx;

drop table if exists bid_ciphertexts;

-- ---------------------------------------------------------------------------
-- rfps — drop indexes that reference dropped columns first
-- ---------------------------------------------------------------------------
drop index if exists rfps_status_idx;
drop index if exists rfps_buyer_wallet_idx;
drop index if exists rfps_category_idx;
drop index if exists rfps_bidder_visibility_idx;

-- Constraint references dropped columns — drop before columns disappear.
alter table rfps drop constraint if exists rfps_window_order;

-- Drop RLS policies that reference dropped columns (e.g. buyer_wallet checks).
drop policy if exists rfps_public_read on rfps;
drop policy if exists rfps_buyer_insert on rfps;
drop policy if exists rfps_buyer_update on rfps;
drop policy if exists rfps_buyer_delete on rfps;

-- Drop columns now mirrored on-chain.
-- Note: `rfp_nonce_hex` is NOT dropped — the on-chain Rfp account doesn't
-- store the nonce (it only appears in the PDA seed), and providers in L1 mode
-- need the exact bytes to deterministically derive their bid_pda_seed:
--   sha256(walletSig("tender-bid-seed-v1" || rfp_nonce))
-- The nonce is public (anyone can scan tx history to recover it), so keeping
-- it in supabase is a denormalization, not a privacy issue.
alter table rfps
  drop column if exists buyer_wallet,
  drop column if exists buyer_encryption_pubkey_hex,
  drop column if exists category,
  drop column if exists budget_max_usdc,
  drop column if exists bid_open_at,
  drop column if exists bid_close_at,
  drop column if exists reveal_close_at,
  drop column if exists status,
  drop column if exists bidder_visibility,
  drop column if exists winner_wallet,
  drop column if exists bid_count;

-- Re-create lean policies. Anyone can read (public marketplace); inserts gated
-- on the JWT presence (the on-chain rfp_create already authenticates the
-- buyer; supabase just mirrors the human-readable text post-tx).
create policy rfps_public_read on rfps
  for select
  using (true);

create policy rfps_authed_insert on rfps
  for insert
  with check (auth.jwt() ->> 'sub' is not null);

-- No update / delete policy — RFP metadata is append-only after the on-chain
-- rfp_create lands. Edits would be a future ix that re-mirrors.

create index if not exists rfps_created_at_idx on rfps (created_at desc);

comment on table rfps is
  'Off-chain metadata for RFPs. Authoritative state (status, bid_count, winner, budget, windows, identity, visibility) lives on the on-chain Rfp account at on_chain_pda. This table holds only the human-readable text fields we never put on chain.';
