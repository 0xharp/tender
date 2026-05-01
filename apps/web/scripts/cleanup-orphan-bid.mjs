#!/usr/bin/env node
/**
 * One-off cleanup: drops a stale bid_ciphertexts row + decrements the host
 * RFP's bid_count, when the on-chain withdraw_bid succeeded but the off-chain
 * DELETE handler rejected (pre-Day-6 L1 DELETE bug — fixed in
 * apps/web/app/api/bids/[on_chain_pda]/route.ts).
 *
 * Usage:
 *   node scripts/cleanup-orphan-bid.mjs <bid_on_chain_pda> [<bid_on_chain_pda> ...]
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing supabase env vars in .env.local');
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node scripts/cleanup-orphan-bid.mjs <bid_pda> [...]');
  process.exit(1);
}

for (const pda of targets) {
  console.log(`\n=== ${pda} ===`);
  const { data: row, error } = await admin
    .from('bid_ciphertexts')
    .select('id, rfp_id, provider_wallet, provider_wallet_hash, bidder_visibility, submitted_at')
    .eq('on_chain_pda', pda)
    .maybeSingle();
  if (error) {
    console.error('  fetch error:', error.message);
    continue;
  }
  if (!row) {
    console.log('  no row found — already cleaned up');
    continue;
  }
  console.log('  found:', row);

  const { data: rfpRow } = await admin
    .from('rfps')
    .select('id, on_chain_pda, bid_count')
    .eq('id', row.rfp_id)
    .single();
  console.log('  host rfp:', rfpRow);

  const { error: delErr } = await admin
    .from('bid_ciphertexts')
    .delete()
    .eq('on_chain_pda', pda);
  if (delErr) {
    console.error('  delete error:', delErr.message);
    continue;
  }
  console.log('  ✓ row deleted');

  if (rfpRow) {
    const newCount = Math.max(0, (rfpRow.bid_count ?? 0) - 1);
    const { error: updErr } = await admin
      .from('rfps')
      .update({ bid_count: newCount })
      .eq('id', rfpRow.id);
    if (updErr) console.error('  count update error:', updErr.message);
    else console.log(`  ✓ bid_count: ${rfpRow.bid_count} → ${newCount}`);
  }
}

console.log('\nDone.');
