import { createClient } from '@supabase/supabase-js';
import type { Database } from '@tender/shared';

import { publicSupabaseUrl, supabaseServiceRoleKey } from './env';

/**
 * Service-role Supabase client. Bypasses RLS — server-only.
 *
 * NEVER import this from a 'use client' module or expose it to the browser.
 * Use only from /api/* route handlers or Server Actions where you've already
 * verified the caller is authorized to perform the privileged action.
 */
export function adminSupabase() {
  return createClient<Database>(publicSupabaseUrl(), supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
