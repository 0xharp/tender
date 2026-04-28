import { createServerClient } from '@supabase/ssr';
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
 * If no session cookie is present, requests go through anonymously.
 */
export async function serverSupabase() {
  const cookieStore = await cookies();
  const sessionJwt = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;

  return createServerClient<Database>(publicSupabaseUrl(), publicSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't set cookies; route handlers set them
          // directly via NextResponse.cookies.set().
        }
      },
    },
    accessToken: async () => sessionJwt,
  });
}
