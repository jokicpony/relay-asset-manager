import { NextResponse } from 'next/server';
import { getLastSyncTimestamp } from '@/lib/sync/upsert';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/sync
 *
 * Returns the last sync timestamp (for UI display).
 */
export async function GET() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const lastSync = await getLastSyncTimestamp();
        return NextResponse.json({ lastSync });
    } catch {
        return NextResponse.json({ lastSync: null });
    }
}
