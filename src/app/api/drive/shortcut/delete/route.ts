import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';

/**
 * DELETE /api/drive/shortcut
 *
 * Deletes Google Drive shortcuts by their file IDs (undo relay).
 * Also removes the corresponding rows from the Supabase `shortcuts` table.
 *
 * Uses a service account (via WIF) for Drive access.
 *
 * Body: { shortcutIds: string[] }
 */
export async function DELETE(request: NextRequest) {
    try {
        const { shortcutIds } = await request.json() as { shortcutIds: string[] };

        if (!shortcutIds || shortcutIds.length === 0) {
            return NextResponse.json({ error: 'No shortcut IDs specified' }, { status: 400 });
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        // Shortcut rows are removed with the service role — RLS allows only
        // service-role writes to the shortcuts table; the user client above is
        // used only for the auth check.
        const admin = createServiceClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        // Authorization: only delete Drive files that are tracked shortcuts.
        // The service account can delete anything it can reach, so without this
        // check any authenticated user could delete arbitrary Drive files by ID.
        const { data: knownRows } = await admin
            .from('shortcuts')
            .select('shortcut_drive_id')
            .in('shortcut_drive_id', shortcutIds);
        const knownIds = new Set((knownRows ?? []).map((r) => r.shortcut_drive_id));

        const results: { id: string; success: boolean; error?: string }[] = [];

        for (const id of shortcutIds) {
            if (!knownIds.has(id)) {
                results.push({ id, success: false, error: 'Not a tracked shortcut' });
                continue;
            }
            try {
                // Delete from Google Drive
                const res = await fetch(
                    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
                    {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${accessToken}` },
                    }
                );

                if (!res.ok && res.status !== 404) {
                    const errData = await res.json().catch(() => ({}));
                    results.push({ id, success: false, error: errData?.error?.message || `HTTP ${res.status}` });
                    continue;
                }

                // Remove from Supabase shortcuts table
                const { error: dbError } = await admin
                    .from('shortcuts')
                    .delete()
                    .eq('shortcut_drive_id', id);

                if (dbError) {
                    logger.warn('shortcut', `DB delete failed for ${id}`, { error: dbError.message });
                }

                results.push({ id, success: true });
            } catch (err) {
                results.push({
                    id,
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        }

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return NextResponse.json({ succeeded, failed, total: shortcutIds.length, results });
    } catch (err) {
        logger.error('shortcut', 'Shortcut deletion error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to delete shortcuts' }, { status: 500 });
    }
}
