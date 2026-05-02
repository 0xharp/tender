-- 0007_drop_dead_columns
--
-- Cleanup pass after the milestone-removal program change.
--
-- After this migration, RFPs describe scope; bids carry the milestone
-- breakdown inside their encrypted envelopes. The on-chain Rfp account
-- gets `milestone_count` + `milestone_percentages` written by `select_bid`
-- at award time, sourced from the winning bid plaintext. Supabase has no
-- reason to know about milestones at all.
--
-- Columns dropped from `rfps`:
--   - milestone_template      — placeholder names ("Milestone 1", …) that
--                               were never used downstream after the buyer
--                               stopped specifying milestone count
--   - scope_detail_encrypted  — never wired up (always null since 0001);
--                               the encrypted-scope flow was deferred
--
-- The `tender:reserve:<rfpPda>` localStorage entry remains the buyer-side
-- holder for reveal_reserve material — that's a UX cache, not a server-side
-- requirement, so no schema change for reserve.

alter table rfps
  drop column if exists milestone_template,
  drop column if exists scope_detail_encrypted;
