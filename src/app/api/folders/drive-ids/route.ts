import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';

/**
 * GET /api/folders/drive-ids
 *
 * Returns the folder path → Google Drive folder ID mapping
 * (stored in app_settings during sync).
 */
export async function GET() {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const adminClient = getAdminClient();

        const { data, error } = await adminClient
            .from('app_settings')
            .select('value')
            .eq('key', 'folder_drive_ids')
            .maybeSingle();

        // A real failure is an error, not an empty mapping — an empty 200
        // made every "Open in Google Drive" link silently disappear.
        if (error) {
            logger.error('folders', 'Failed to load folder_drive_ids', { error: error.message });
            return NextResponse.json({ error: 'Failed to load folder mapping' }, { status: 500 });
        }
        // No mapping yet (fresh install, before the first sync) is legitimately empty
        return NextResponse.json(data?.value ?? {});
    } catch (err) {
        logger.error('folders', 'Failed to load folder_drive_ids', { error: String(err) });
        return NextResponse.json({ error: 'Failed to load folder mapping' }, { status: 500 });
    }
}
