-- Tender — RLS policies (Day 4 Phase B)
--
-- Identity model:
--   - Anonymous (no JWT) — anyone visiting the site without signing in
--   - Authenticated (JWT with sub = wallet address, role = authenticated) —
--     issued by /api/auth/siws after a successful Sign-In With Solana flow
--
-- Helper for clarity: auth.jwt() ->> 'sub' returns the wallet address of
-- the signed-in caller, or NULL if anonymous.

-- ---------------------------------------------------------------------------
-- providers
-- ---------------------------------------------------------------------------
alter table providers enable row level security;

drop policy if exists providers_public_read on providers;
create policy providers_public_read on providers
  for select
  using (true);

drop policy if exists providers_self_insert on providers;
create policy providers_self_insert on providers
  for insert
  with check (wallet = auth.jwt() ->> 'sub');

drop policy if exists providers_self_update on providers;
create policy providers_self_update on providers
  for update
  using (wallet = auth.jwt() ->> 'sub')
  with check (wallet = auth.jwt() ->> 'sub');

-- No DELETE policy → providers can't delete their profile (intentional;
-- reputation is meant to be append-only).

-- ---------------------------------------------------------------------------
-- rfps
-- ---------------------------------------------------------------------------
alter table rfps enable row level security;

drop policy if exists rfps_public_read on rfps;
create policy rfps_public_read on rfps
  for select
  using (true);

drop policy if exists rfps_buyer_insert on rfps;
create policy rfps_buyer_insert on rfps
  for insert
  with check (buyer_wallet = auth.jwt() ->> 'sub');

drop policy if exists rfps_buyer_update on rfps;
create policy rfps_buyer_update on rfps
  for update
  using (buyer_wallet = auth.jwt() ->> 'sub')
  with check (buyer_wallet = auth.jwt() ->> 'sub');

-- No DELETE policy → buyers can't delete their RFPs (status transitions to
-- 'cancelled' instead, preserving history).

-- ---------------------------------------------------------------------------
-- reputation_cache
-- ---------------------------------------------------------------------------
alter table reputation_cache enable row level security;

drop policy if exists reputation_public_read on reputation_cache;
create policy reputation_public_read on reputation_cache
  for select
  using (true);

-- No INSERT/UPDATE/DELETE policy → only the service-role client (admin) can
-- write reputation. The on-chain reputation registry is canonical; Supabase
-- is just a fast-read cache populated by a server-side sync worker.
