import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/auth/check
 *
 * Lightweight check to determine if the user has a valid session.
 * Since Drive operations now use a service account (via WIF), we only
 * need to verify the user's Supabase session — no Google token validation.
 *
 * Returns { connected: true/false }.
 */
export async function GET() {
    try {
        const supabase = await createClient();
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            return NextResponse.json({ connected: false, reason: 'no_session' });
        }

        return NextResponse.json({ connected: true });
    } catch {
        return NextResponse.json({ connected: false, reason: 'error' });
    }
}
