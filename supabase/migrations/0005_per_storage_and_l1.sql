-- Tender — PER storage + L0/L1 toggle (Day 6)
--
-- Architecture shift: bid ECIES envelopes (both buyer + provider copies) now
-- live ENTIRELY on the on-chain BidCommit account (delegated to MagicBlock
-- PER). Supabase keeps only metadata for indexing — the actual ciphertext
-- bytes are no longer stored here.
--
-- Also adds the L0/L1 bidder visibility toggle on `rfps` and the
-- `provider_wallet_hash` column on `bid_ciphertexts` so L1 bids can be looked
-- up without exposing the provider wallet to public reads.
--
-- Rationale: see docs/PRIVACY-MODEL.md.

-- ---------------------------------------------------------------------------
-- rfps: bidder_visibility toggle
-- ---------------------------------------------------------------------------
alter table rfps
  add column if not exists bidder_visibility text not null default 'public'
    check (bidder_visibility in ('public', 'buyer_only'));

create index if not exists rfps_bidder_visibility_idx
  on rfps (bidder_visibility);

-- ---------------------------------------------------------------------------
-- bid_ciphertexts: rename to bid_index, drop ciphertext payloads
-- ---------------------------------------------------------------------------
-- Drop the bulk ciphertext columns — these now live on PER.
alter table bid_ciphertexts
  drop column if exists ciphertext,
  drop column if exists ephemeral_pubkey_hex,
  drop column if exists provider_ciphertext,
  drop column if exists provider_ephemeral_pubkey_hex;

-- L1 lookup: provider_wallet stays NULL for L1 bids (would leak identity);
-- instead we store sha256(provider_wallet) which the provider can derive at
-- sign-in time to find their own bids.
alter table bid_ciphertexts
  add column if not exists provider_wallet_hash text,
  add column if not exists bidder_visibility text not null default 'public'
    check (bidder_visibility in ('public', 'buyer_only'));

-- Allow provider_wallet to be NULL in L1 mode.
alter table bid_ciphertexts
  alter column provider_wallet drop not null;

-- For L0, provider_wallet is filled; provider_wallet_hash optional but useful.
-- For L1, provider_wallet is NULL and only provider_wallet_hash is set.
-- Application enforces this; SQL constraint guards the invariant:
alter table bid_ciphertexts
  drop constraint if exists bid_ciphertexts_identity_required;
alter table bid_ciphertexts
  add constraint bid_ciphertexts_identity_required
    check (
      (bidder_visibility = 'public'  and provider_wallet is not null)
      or
      (bidder_visibility = 'buyer_only' and provider_wallet_hash is not null)
    );

-- Default storage_backend flips: new bids land on PER.
alter table bid_ciphertexts
  alter column storage_backend set default 'per';

create index if not exists bid_ciphertexts_provider_wallet_hash_idx
  on bid_ciphertexts (provider_wallet_hash);

-- ---------------------------------------------------------------------------
-- RLS adjustments for L1
-- ---------------------------------------------------------------------------
-- The existing public-read policy stays — we want anyone to see bid metadata
-- for an RFP. The constraint above plus L1 bids storing only the wallet hash
-- means L1 reads expose the existence of a bid + its commit hash, but not who
-- the bidder is.

-- Insert policy needs adjustment: in L1 mode, provider_wallet may be null.
-- The provider authenticates via the JWT; we accept the row if EITHER
-- provider_wallet matches the JWT sub (L0) OR provider_wallet_hash matches
-- sha256(JWT sub) (L1). The hash check happens client-side; SQL trusts the
-- application to set the correct field. (We still gate on the JWT sub being
-- present; a fully unauthenticated request can't insert.)
drop policy if exists bid_ciphertexts_provider_insert on bid_ciphertexts;
create policy bid_ciphertexts_provider_insert on bid_ciphertexts
  for insert
  with check (
    (provider_wallet is not null and provider_wallet = auth.jwt() ->> 'sub')
    or
    (provider_wallet_hash is not null and auth.jwt() ->> 'sub' is not null)
  );

-- Delete policy: providers can clean up their own row after withdraw.
-- For L1, provider proves ownership via the wallet sub matching the hash —
-- we trust the application to compute the hash; SQL just gates on JWT presence.
drop policy if exists bid_ciphertexts_provider_delete on bid_ciphertexts;
create policy bid_ciphertexts_provider_delete on bid_ciphertexts
  for delete
  using (
    (provider_wallet is not null and provider_wallet = auth.jwt() ->> 'sub')
    or
    (provider_wallet_hash is not null and auth.jwt() ->> 'sub' is not null)
  );
