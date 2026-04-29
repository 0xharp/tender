-- Tender — encrypt-to-both for bids (Day 5 amendment)
--
-- Each bid now stores TWO ECIES ciphertexts of the same plaintext:
--   - ciphertext (existing) — encrypted to BUYER's RFP-specific X25519 pubkey.
--                              On-chain commit_hash references this one.
--   - provider_ciphertext (new) — encrypted to PROVIDER's wallet-derived
--                                  X25519 pubkey, so the provider can decrypt
--                                  their own bids back without the buyer.
--
-- Plaintext is NEVER stored. Decryption stays client-side only.
--
-- The new columns are NULLable for backwards compat. Bids submitted before
-- this migration stay sealed-from-provider (provider can withdraw them
-- on-chain via the existing withdraw_bid ix). New bids fill both columns.

alter table bid_ciphertexts
  add column if not exists provider_ciphertext bytea,
  add column if not exists provider_ephemeral_pubkey_hex text;

-- ---------------------------------------------------------------------------
-- RLS DELETE policy: providers can clean up their own row after an on-chain
-- withdraw_bid transaction. The off-chain row is just a mirror; the chain is
-- canonical. We don't soft-delete (no withdrawn_at column) for simplicity —
-- the on-chain tx history preserves the audit trail.
-- ---------------------------------------------------------------------------
drop policy if exists bid_ciphertexts_provider_delete on bid_ciphertexts;
create policy bid_ciphertexts_provider_delete on bid_ciphertexts
  for delete
  using (provider_wallet = auth.jwt() ->> 'sub');
