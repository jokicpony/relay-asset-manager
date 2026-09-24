import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

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
            .single();

        if (error || !data?.value) {
            return NextResponse.json({});
        }

        return NextResponse.json(data.value);
    } catch {
        return NextResponse.json({});
    }
}
