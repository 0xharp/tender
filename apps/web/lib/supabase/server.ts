import { createClient } from '@supabase/supabase-js';
import type { Database } from '@tender/shared';
import { cookies } from 'next/headers';

import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { publicSupabaseAnonKey, publicSupabaseUrl } from './env';

/**
 * Server-side Supabase client. Use from Server Components, Route Handlers,
 * and Server Actions.
 *
 * Reads the SIWS-issued JWT from the `tender-session` httpOnly cookie and
 * supplies it as the `accessToken` for every Supabase request, so RLS sees
 * `auth.jwt() ->> 'sub'` = the connected wallet address.
 *
 * Implementation note: we use raw `@supabase/supabase-js` (not `@supabase/ssr`)
 * because ssr's cookie-based session sync conflicts with the custom
 * `accessToken` option - we manage the JWT cookie ourselves in /api/auth/siws.
 *
 * If no session cookie is present, requests go through anonymously.
 */
export async function serverSupabase() {
  const cookieStore = await cookies();
  const sessionJwt = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;

  return createClient<Database>(publicSupabaseUrl(), publicSupabaseAnonKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    accessToken: async () => sessionJwt,
  });
}
