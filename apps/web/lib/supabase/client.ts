'use client';

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@tender/shared';

import { publicSupabaseAnonKey, publicSupabaseUrl } from './env';

/**
 * Browser-side Supabase client - anonymous only.
 *
 * The session JWT lives in an httpOnly cookie that JS can't read, so the
 * browser client cannot impersonate the signed-in wallet directly.
 *
 * For authenticated writes, always go through `/api/*` route handlers that
 * use `serverSupabase()` (which can read the httpOnly cookie).
 *
 * This client is suitable for: public-read queries, real-time subscriptions
 * to public data, anon-allowed writes (none in our schema).
 */
export function browserSupabase() {
  return createClient<Database>(publicSupabaseUrl(), publicSupabaseAnonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
