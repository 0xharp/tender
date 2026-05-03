-- 0008_milestone_notes
--
-- Append-only off-chain notes attached to milestone state transitions.
--
-- The on-chain milestone status is the source of truth for state ("Submitted",
-- "RequestedChanges", "Accepted", "Disputed"). What the chain CAN'T carry is
-- the human context behind each transition - "here's the deliverable link",
-- "section 3 needs more polish", "matches spec, paying out". That's what this
-- table is for.
--
-- Design choices:
--   - Append-only (no UPDATE/DELETE policy) so the audit trail can't be
--     rewritten after-the-fact during disputes. The chain action is immutable;
--     the note attached to it should be too.
--   - Public read (anyone can see the thread on the RFP detail page) - this is
--     the same surface where on-chain milestone status is already public.
--   - Self-insert only via SIWS JWT - author_wallet must match the signed-in
--     wallet, so providers can't post as buyers and vice versa.
--   - `kind` is a check-constrained text rather than an enum, so future
--     transitions (accept-with-note, dispute-propose-rationale) can be added
--     by widening the check without a migration on the column type.
--   - `tx_signature` is nullable but populated when the note is attached to a
--     specific on-chain action - lets the UI render "Submit · 2m ago · view tx".

create table if not exists milestone_notes (
  id                uuid primary key default gen_random_uuid(),
  rfp_pda           text not null,
  milestone_index   smallint not null check (milestone_index between 0 and 7),
  author_wallet     text not null,
  kind              text not null check (kind in (
                      'submit',
                      'request_changes',
                      'reject',
                      'accept',
                      'dispute_propose',
                      'comment'
                    )),
  body              text not null check (char_length(body) between 1 and 2000),
  tx_signature      text,
  created_at        timestamptz not null default now()
);

create index if not exists milestone_notes_rfp_idx
  on milestone_notes (rfp_pda, milestone_index, created_at desc);

create index if not exists milestone_notes_author_idx
  on milestone_notes (author_wallet, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table milestone_notes enable row level security;

drop policy if exists milestone_notes_public_read on milestone_notes;
create policy milestone_notes_public_read on milestone_notes
  for select
  using (true);

drop policy if exists milestone_notes_self_insert on milestone_notes;
create policy milestone_notes_self_insert on milestone_notes
  for insert
  with check (author_wallet = auth.jwt() ->> 'sub');

-- No UPDATE / DELETE policies. Notes are append-only forever.
