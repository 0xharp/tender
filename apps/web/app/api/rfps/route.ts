/**
 * RFP metadata API.
 *
 * After the Day 6.5 supabase shrink + the milestone-removal pass, supabase
 * only stores the human-readable scope text we never put on-chain (title,
 * scope_summary). Milestones are entirely a bid-side concern now (they live
 * inside the encrypted bid envelope). Everything else (windows, status,
 * bid_count, winner, identity, visibility, category, milestone count once
 * awarded) lives on the on-chain Rfp account at `on_chain_pda`.
 *
 *   POST  - write metadata after the on-chain rfp_create tx confirms. Caller
 *           must be SIWS-signed (any wallet can pin metadata for an RFP they
 *           created on-chain - the on-chain account itself enforces buyer
 *           identity).
 *   GET   - list metadata rows. Clients enrich by reading on-chain Rfp
 *           accounts via `lib/solana/chain-reads.ts`.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import bs58 from 'bs58';
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { type EphemeralAuth, rfpCreatePayloadSchema } from '@/lib/rfps/schema';
import { fetchRfp } from '@/lib/solana/chain-reads';
import { serverSupabase } from '@/lib/supabase/server';

const METADATA_PIN_DOMAIN = 'tender-metadata-pin-v1';
const PIN_FRESHNESS_WINDOW_MS = 5 * 60_000;

/**
 * Verify the ephemeral self-signed metadata-pin auth. Returns the
 * verified signer pubkey (base58) on success, or an error string.
 *
 * Verification chain:
 *   1. Message parses to {domain, program, rfp, title_hash, issued_at}
 *   2. domain == 'tender-metadata-pin-v1' (no replay across versions)
 *   3. rfp field == body.on_chain_pda
 *   4. title_hash == sha256(body.title) byte-for-byte
 *   5. issued_at within ±5 minutes of server clock
 *   6. ed25519 signature is valid against `rfp.buyer` on chain — only
 *      that pubkey can pin metadata for this RFP
 */
async function verifyEphemeralAuth(
  ephAuth: EphemeralAuth,
  body: { on_chain_pda: string; title: string },
): Promise<{ ok: true; signer: string } | { ok: false; error: string }> {
  const lines = ephAuth.message.split('\n');
  const fields = new Map<string, string>();
  if (lines[0] !== METADATA_PIN_DOMAIN) {
    return { ok: false, error: 'wrong domain prefix' };
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    fields.set(line.slice(0, eq), line.slice(eq + 1));
  }

  const claimedRfp = fields.get('rfp');
  if (claimedRfp !== body.on_chain_pda) {
    return { ok: false, error: 'rfp mismatch — message pinned a different RFP' };
  }
  const claimedTitleHash = fields.get('title_hash');
  const expectedTitleHash = bytesToHex(sha256(new TextEncoder().encode(body.title)));
  if (claimedTitleHash !== expectedTitleHash) {
    return { ok: false, error: 'title_hash mismatch — bait-and-switch attempt' };
  }
  const issuedAt = fields.get('issued_at');
  if (!issuedAt) return { ok: false, error: 'missing issued_at' };
  const issuedTs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedTs)) return { ok: false, error: 'invalid issued_at' };
  if (Math.abs(Date.now() - issuedTs) > PIN_FRESHNESS_WINDOW_MS) {
    return { ok: false, error: 'pin too old or too far in future (replay defense)' };
  }

  // Resolve the signing pubkey: the ephemeral that owns this RFP on
  // chain. We refuse to even fetch the supabase row if the RFP doesn't
  // exist — preventing pre-emptive metadata squatting.
  let chainRfp: Awaited<ReturnType<typeof fetchRfp>>;
  try {
    chainRfp = await fetchRfp(body.on_chain_pda as never);
  } catch (e) {
    return { ok: false, error: `chain fetch failed: ${(e as Error).message}` };
  }
  if (!chainRfp) {
    return { ok: false, error: 'rfp not found on chain — cannot verify signer' };
  }
  const expectedSigner = String(chainRfp.buyer);

  // Decode signature + verify.
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(Buffer.from(ephAuth.signature, 'base64'));
  } catch {
    return { ok: false, error: 'invalid signature encoding' };
  }
  if (signatureBytes.byteLength !== 64) {
    return { ok: false, error: `signature must be 64 bytes, got ${signatureBytes.byteLength}` };
  }
  const messageBytes = new TextEncoder().encode(ephAuth.message);
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = Uint8Array.from(bs58.decode(expectedSigner));
  } catch {
    return { ok: false, error: 'could not decode rfp.buyer pubkey' };
  }
  const valid = ed25519.verify(signatureBytes, messageBytes, pubkeyBytes);
  if (!valid) {
    return { ok: false, error: 'signature does not match rfp.buyer on chain' };
  }
  return { ok: true, signer: expectedSigner };
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = rfpCreatePayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  // Two auth paths:
  //  - ephemeral_auth present → ephemeral self-signed pin (private RFPs;
  //    no main-wallet correlation in audit logs)
  //  - else → existing SIWS session (public RFPs, today's flow)
  if (payload.ephemeral_auth) {
    const verdict = await verifyEphemeralAuth(payload.ephemeral_auth, {
      on_chain_pda: payload.on_chain_pda,
      title: payload.title,
    });
    if (!verdict.ok) {
      return NextResponse.json(
        { error: `ephemeral auth rejected: ${verdict.error}` },
        { status: 401 },
      );
    }
  } else {
    const wallet = await getCurrentWallet();
    if (!wallet) {
      return NextResponse.json({ error: 'not signed in' }, { status: 401 });
    }
  }

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .insert({
      on_chain_pda: payload.on_chain_pda,
      rfp_nonce_hex: payload.rfp_nonce_hex,
      title: payload.title,
      scope_summary: payload.scope_summary,
      tx_signature: payload.tx_signature,
    })
    .select('id, on_chain_pda')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rfp: data });
}

export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit') ?? '50'), 1), 100);

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('rfps')
    .select('id, on_chain_pda, title, scope_summary, tx_signature, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Status filtering happens client-side after enriching with on-chain Rfp data.
  return NextResponse.json({ rfps: data });
}
