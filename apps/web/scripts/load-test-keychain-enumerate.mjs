#!/usr/bin/env node
/**
 * Load test: simulates the v2 HD-keychain enumeration cost against the
 * configured RPC. Fires 64 parallel `getProgramAccounts` memcmp queries
 * with random pubkeys (proxying ephemeral pubkeys we'd derive at
 * runtime), measures per-call latency, and reports p50/p95/max + total
 * wall time.
 *
 * The number to validate is the UX claim made in the plan:
 *   "scan 64 ephemerals in ~600ms over a good RPC."
 *
 * Anything notably above ~1.5s suggests the RPC won't keep up with the
 * private-bids/private-rfps discover panels and we need to either
 * shrink the default scan window or chunk the batch.
 *
 * Usage:
 *   node apps/web/scripts/load-test-keychain-enumerate.mjs [SCAN_WINDOW]
 *
 * Env:
 *   NEXT_PUBLIC_SOLANA_RPC_URL   the RPC to test against
 *                                 (defaults to apps/web/.env.local)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// Lightweight .env.local reader so we don't need dotenv installed.
function loadEnvLocal() {
  const envPath = path.join(repoRoot, 'apps/web/.env.local');
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const envFile = loadEnvLocal();
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? envFile.NEXT_PUBLIC_SOLANA_RPC_URL;
if (!RPC_URL) {
  console.error(
    'No RPC URL configured — set NEXT_PUBLIC_SOLANA_RPC_URL in apps/web/.env.local or env.',
  );
  process.exit(1);
}

const TENDER_PROGRAM_ID = 'GJe2DPcCBja5MLEenV2aeidsNxYavUMmA8eTJz8nSs9Z';

const SCAN_WINDOW = Number(process.argv[2] ?? 64);
if (!Number.isFinite(SCAN_WINDOW) || SCAN_WINDOW < 1 || SCAN_WINDOW > 1024) {
  console.error(`Invalid scan window ${process.argv[2]}; must be 1..1024`);
  process.exit(1);
}

// Anchor `BidCommit` discriminator (sha256("account:BidCommit")[0..8]).
// We filter on it to mimic the real `listBids` call shape — without the
// discriminator filter the RPC scans the whole program-owned set, which
// is much cheaper than the realistic memcmp-after-discriminator load.
import { createHash } from 'node:crypto';
const BID_DISC = createHash('sha256').update('account:BidCommit').digest().subarray(0, 8);

// 32-byte random pubkey → base58. We don't care if it's curve-valid
// (memcmp doesn't care either); the RPC just needs 32 random bytes.
function randomBase58Pubkey() {
  const buf = new Uint8Array(32);
  globalThis.crypto.getRandomValues(buf);
  return base58Encode(buf);
}

// Minimal base58 encoder (no extra deps).
function base58Encode(input) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const b of input) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const b of input) {
    if (b === 0) leadingZeros++;
    else break;
  }
  return (
    '1'.repeat(leadingZeros) +
    digits
      .reverse()
      .map((d) => ALPHABET[d])
      .join('')
  );
}

function bytesToBase58(buf) {
  return base58Encode(buf);
}

async function gpaMemcmp(pubkeyBase58) {
  // Mirrors `listBids({ providerWallet })` — discriminator at offset 0,
  // provider pubkey at offset 80 (per the BidCommit layout comment in
  // chain-reads.ts).
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getProgramAccounts',
    params: [
      TENDER_PROGRAM_ID,
      {
        encoding: 'base64',
        filters: [
          { memcmp: { offset: 0, bytes: bytesToBase58(BID_DISC) } },
          { memcmp: { offset: 80, bytes: pubkeyBase58 } },
        ],
      },
    ],
  };
  const t0 = performance.now();
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = performance.now() - t0;
  if (!res.ok) {
    return { elapsedMs: elapsed, ok: false, status: res.status };
  }
  const json = await res.json();
  const found = Array.isArray(json.result) ? json.result.length : 0;
  return { elapsedMs: elapsed, ok: true, found };
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  console.log(`RPC:           ${RPC_URL.replace(/(api[_-]?key=)[^&]+/i, '$1<redacted>')}`);
  console.log(`Program:       ${TENDER_PROGRAM_ID}`);
  console.log(`Scan window:   ${SCAN_WINDOW}`);
  console.log('Filters:       discriminator(0..8) + memcmp(provider@80)');
  console.log('');

  // Warm-up: 1 sequential call so DNS / TLS / RPC pool init isn't
  // counted in the first parallel batch's latencies.
  const warm = randomBase58Pubkey();
  console.log('Warming up the connection (1 sequential call)…');
  const warmResult = await gpaMemcmp(warm);
  if (!warmResult.ok) {
    console.error(`Warm-up FAILED with HTTP ${warmResult.status}. Aborting.`);
    process.exit(1);
  }
  console.log(`Warm-up: ${warmResult.elapsedMs.toFixed(0)}ms`);
  console.log('');

  // Real test: SCAN_WINDOW parallel queries.
  console.log(`Firing ${SCAN_WINDOW} parallel getProgramAccounts queries…`);
  const pubkeys = Array.from({ length: SCAN_WINDOW }, () => randomBase58Pubkey());
  const t0 = performance.now();
  const results = await Promise.all(pubkeys.map((pk) => gpaMemcmp(pk)));
  const totalMs = performance.now() - t0;

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const latencies = results.filter((r) => r.ok).map((r) => r.elapsedMs);

  console.log('');
  console.log('=== Results ===');
  console.log(`Total wall time:   ${totalMs.toFixed(0)}ms`);
  console.log(`Successful calls:  ${okCount} / ${SCAN_WINDOW}`);
  if (failCount > 0) {
    const statuses = results.filter((r) => !r.ok).map((r) => r.status);
    console.log(`Failed calls:      ${failCount} (statuses: ${[...new Set(statuses)].join(', ')})`);
  }
  if (latencies.length > 0) {
    console.log('Per-call latency:');
    console.log(`  min:             ${Math.min(...latencies).toFixed(0)}ms`);
    console.log(`  p50:             ${pct(latencies, 50).toFixed(0)}ms`);
    console.log(`  p95:             ${pct(latencies, 95).toFixed(0)}ms`);
    console.log(`  max:             ${Math.max(...latencies).toFixed(0)}ms`);
    console.log(
      `  mean:            ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`,
    );
  }
  const totalHits = results.reduce((acc, r) => acc + (r.found ?? 0), 0);
  console.log(`Bids found:        ${totalHits} (random pubkeys → expected 0)`);
  console.log('');

  console.log('=== UX claim check ===');
  const claim = 600;
  if (totalMs <= claim) {
    console.log(
      `✓ Total ${totalMs.toFixed(0)}ms ≤ ${claim}ms claim. Discover panels will feel snappy.`,
    );
  } else if (totalMs <= claim * 2.5) {
    console.log(
      `~ Total ${totalMs.toFixed(0)}ms above ${claim}ms but within 2.5x. Acceptable for v1; consider chunking the batch in v2.1 if it consistently exceeds 1s.`,
    );
  } else {
    console.log(
      `✗ Total ${totalMs.toFixed(0)}ms is >2.5x the ${claim}ms claim. Drop default SCAN_WINDOW to 32 or batch in halves.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
