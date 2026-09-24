import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Service-role Supabase client for server-side reads/writes (bypasses RLS).
 *
 * Throws instead of falling back to the anon key: under the RLS lockdown,
 * anon-key writes don't error — updates silently affect zero rows — so a
 * missing service key must fail loudly, not degrade into no-op writes.
 *
 * Lazy so that importing a route module never throws at build time in an
 * environment without env vars; the error surfaces on first request instead.
 */
export function getAdminClient(): SupabaseClient {
    if (cached) return cached;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error(
            'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — '
            + 'server-side Supabase access requires the service role key.'
        );
    }

    cached = createClient(url, key);
    return cached;
}
