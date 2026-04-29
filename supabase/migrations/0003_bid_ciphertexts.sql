-- Tender — bid_ciphertexts (Day 5)
--
-- Stores ECIES-encrypted bid blobs alongside the on-chain commit hash.
-- Day 5: storage_backend defaults to 'supabase'. The column shape allows
-- swapping the backend later (e.g. private-state rollup or content-addressed
-- storage) with a single per-row update.
--
-- Privacy model: there is no row-level secrecy on this table. The
-- ciphertext IS public — confidentiality comes from ECIES (only the
-- buyer's X25519 priv can decrypt). RLS controls *who can write*
-- (the provider whose JWT sub matches provider_wallet) and *who can
-- delete* (no one — bids are append-only; withdraw is a separate
-- on-chain action that closes the BidCommit PDA).

create table if not exists bid_ciphertexts (
  id                           uuid primary key default gen_random_uuid(),
  on_chain_pda                 text unique not null,           -- BidCommit PDA address
  rfp_id                       uuid not null references rfps(id) on delete cascade,
  rfp_pda                      text not null,                  -- denormalized for fast joins
  provider_wallet              text not null,
  ciphertext                   bytea not null,                 -- ECIES blob (eph_pub || nonce || ct+tag)
  ephemeral_pubkey_hex         text not null,                  -- duplicated from blob head for indexing
  commit_hash_hex              text not null,                  -- sha256(ciphertext) hex; matches on-chain
  storage_backend              text not null default 'supabase'
                                  check (storage_backend in ('supabase', 'ipfs', 'arweave', 'per')),
  per_session_id               text,                           -- non-null when storage_backend = 'per'
  submitted_at                 timestamptz not null default now()
);

create index if not exists bid_ciphertexts_rfp_id_idx
  on bid_ciphertexts (rfp_id);
create index if not exists bid_ciphertexts_provider_wallet_idx
  on bid_ciphertexts (provider_wallet);
create index if not exists bid_ciphertexts_commit_hash_idx
  on bid_ciphertexts (commit_hash_hex);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table bid_ciphertexts enable row level security;

-- Public read: ciphertexts are encrypted; openness here is by design.
-- Buyers fetch all ciphertexts for their RFP and decrypt locally.
drop policy if exists bid_ciphertexts_public_read on bid_ciphertexts;
create policy bid_ciphertexts_public_read on bid_ciphertexts
  for select
  using (true);

-- Insert: only the provider whose wallet matches the JWT subject can write
-- their own bid row.
drop policy if exists bid_ciphertexts_provider_insert on bid_ciphertexts;
create policy bid_ciphertexts_provider_insert on bid_ciphertexts
  for insert
  with check (provider_wallet = auth.jwt() ->> 'sub');

-- No UPDATE policy: bids are append-only. Re-bid = withdraw old + commit new.
-- No DELETE policy: provider can withdraw on-chain (via withdraw_bid ix);
-- the off-chain row stays as historical record. A future cleanup ix or sync
-- worker can soft-mark it.
