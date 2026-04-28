/**
 * Supabase env access — fail loud at module load if any required var is missing.
 *
 * Browser-safe vars use the NEXT_PUBLIC_ prefix and are bundled into the
 * client. The service-role key is intentionally NOT prefixed and must only
 * ever be read from server contexts.
 */

export function publicSupabaseUrl(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required (see .env.example)');
  return v;
}

export function publicSupabaseAnonKey(): string {
  const v = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!v) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is required (see .env.example)');
  return v;
}

/** Server-only. Throws if called from a context where the var isn't available. */
export function supabaseServiceRoleKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required server-side (see .env.example). ' +
        'NEVER expose this to the browser.',
    );
  }
  return v;
}

/** Server-only. JWT secret used to mint Supabase-compatible session JWTs in /api/auth/siws. */
export function supabaseJwtSecret(): string {
  const v = process.env.SUPABASE_JWT_SECRET;
  if (!v) {
    throw new Error(
      'SUPABASE_JWT_SECRET is required server-side (see .env.example). ' +
        'Found under Project Settings → API → JWT Settings in Supabase dashboard.',
    );
  }
  return v;
}
