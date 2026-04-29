/**
 * Bid ciphertext storage API.
 *
 *   POST — write a sealed-bid ciphertext blob after the on-chain commit_bid
 *          tx has confirmed. RLS enforces provider_wallet = JWT sub.
 *   GET  — list all ciphertexts for a given RFP (public read; ECIES is the
 *          confidentiality layer).
 */
import { type NextRequest, NextResponse } from 'next/server';

import { getCurrentWallet } from '@/lib/auth/session';
import { bidPostPayloadSchema } from '@/lib/bids/schema';
import { adminSupabase } from '@/lib/supabase/admin';
import { serverSupabase } from '@/lib/supabase/server';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Postgres bytea hex-input format. Supabase JS doesn't auto-encode `Uint8Array`
 * for bytea columns — passing one through JSON.stringify produces an indexed
 * object literal that Postgres silently writes as garbage (or null). The hex
 * literal `\x...` is the canonical bytea-input string format.
 */
function uint8ToBytea(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return `\\x${hex}`;
}

export async function POST(req: NextRequest) {
  const wallet = await getCurrentWallet();
  if (!wallet) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = bidPostPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const ciphertextHex = uint8ToBytea(base64ToBytes(payload.ciphertext_base64));
  const providerCiphertextHex = uint8ToBytea(base64ToBytes(payload.provider_ciphertext_base64));

  const supabase = await serverSupabase();
  const { data, error } = await supabase
    .from('bid_ciphertexts')
    .insert({
      on_chain_pda: payload.on_chain_pda,
      rfp_id: payload.rfp_id,
      rfp_pda: payload.rfp_pda,
      provider_wallet: wallet,
      // Cast: TypeScript expects Uint8Array (declared schema), but Postgres
      // bytea expects the hex-literal string format on the wire. Supabase JS
      // forwards it verbatim.
      ciphertext: ciphertextHex as unknown as Uint8Array,
      ephemeral_pubkey_hex: payload.ephemeral_pubkey_hex,
      commit_hash_hex: payload.commit_hash_hex,
      provider_ciphertext: providerCiphertextHex as unknown as Uint8Array,
      provider_ephemeral_pubkey_hex: payload.provider_ephemeral_pubkey_hex,
      storage_backend: payload.storage_backend,
      per_session_id: payload.per_session_id ?? null,
    })
    .select('id, on_chain_pda')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Bump rfps.bid_count via admin client (RLS allows only the buyer to update
  // rfps; the bid-counter mirror is a pure aggregate and should track every
  // ciphertext insert). Future: replace with a Postgres trigger.
  // Failure here doesn't fail the request — the ciphertext is the source of
  // truth; a stale counter is recoverable by a sync worker.
  const admin = adminSupabase();
  const { data: rfpRow } = await admin
    .from('rfps')
    .select('bid_count')
    .eq('id', payload.rfp_id)
    .single();
  if (rfpRow) {
    await admin
      .from('rfps')
      .update({ bid_count: (rfpRow.bid_count ?? 0) + 1 })
      .eq('id', payload.rfp_id);
  }

  return NextResponse.json({ ok: true, bid: data });
}

export async function GET(req: NextRequest) {
  const rfpId = req.nextUrl.searchParams.get('rfp_id');
  const rfpPda = req.nextUrl.searchParams.get('rfp_pda');
  const providerWallet = req.nextUrl.searchParams.get('provider_wallet');

  if (!rfpId && !rfpPda && !providerWallet) {
    return NextResponse.json(
      { error: 'one of rfp_id | rfp_pda | provider_wallet query params required' },
      { status: 400 },
    );
  }

  const supabase = await serverSupabase();
  let query = supabase
    .from('bid_ciphertexts')
    .select(
      'id, on_chain_pda, rfp_id, rfp_pda, provider_wallet, ephemeral_pubkey_hex, commit_hash_hex, ciphertext, provider_ephemeral_pubkey_hex, provider_ciphertext, storage_backend, per_session_id, submitted_at',
    )
    .order('submitted_at', { ascending: false })
    .limit(200);

  if (rfpId) query = query.eq('rfp_id', rfpId);
  if (rfpPda) query = query.eq('rfp_pda', rfpPda);
  if (providerWallet) query = query.eq('provider_wallet', providerWallet);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Normalize bytea fields to base64 strings before sending. Supabase + PostgREST
  // can return bytea as a hex-prefixed string ("\\x..."), as a Buffer-shaped
  // object, or as raw bytes depending on driver/version. Encoding explicitly
  // here gives the client one canonical format.
  const normalized = (data ?? []).map((row) => ({
    id: row.id,
    on_chain_pda: row.on_chain_pda,
    rfp_id: row.rfp_id,
    rfp_pda: row.rfp_pda,
    provider_wallet: row.provider_wallet,
    ephemeral_pubkey_hex: row.ephemeral_pubkey_hex,
    commit_hash_hex: row.commit_hash_hex,
    provider_ephemeral_pubkey_hex: row.provider_ephemeral_pubkey_hex,
    storage_backend: row.storage_backend,
    per_session_id: row.per_session_id,
    submitted_at: row.submitted_at,
    ciphertext_base64: byteaToBase64(row.ciphertext),
    provider_ciphertext_base64: byteaToBase64(row.provider_ciphertext),
  }));

  return NextResponse.json({ bids: normalized });
}

/** Convert any of Supabase's bytea representations into a base64 string. */
function byteaToBase64(value: unknown): string | null {
  if (value == null) return null;
  const bytes = byteaToUint8(value);
  if (!bytes) return null;
  return Buffer.from(bytes).toString('base64');
}

function byteaToUint8(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {
      // Postgres hex format: "\xDEADBEEF..."
      const hex = value.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    // Try base64
    try {
      return new Uint8Array(Buffer.from(value, 'base64'));
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && value !== null && 'data' in value) {
    const data = (value as { data: unknown }).data;
    if (Array.isArray(data)) return new Uint8Array(data);
  }
  return null;
}
