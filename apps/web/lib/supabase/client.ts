'use client';

import { type SupabaseClient, createClient } from '@supabase/supabase-js';
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
 *
 * Module-singleton: every call returns the SAME client instance for the
 * lifetime of the tab. Without this, supabase-js initializes a fresh
 * GoTrueClient per call, all pointing at the same `sb-*-auth-token`
 * storage key — supabase warns ("Multiple GoTrueClient instances") and
 * concurrent reads can race. We disable auth persistence anyway (anon
 * client), so a single instance is correct + free.
 */
let cachedClient: SupabaseClient<Database> | null = null;

export function browserSupabase(): SupabaseClient<Database> {
  if (!cachedClient) {
    cachedClient = createClient<Database>(publicSupabaseUrl(), publicSupabaseAnonKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return cachedClient;
}
