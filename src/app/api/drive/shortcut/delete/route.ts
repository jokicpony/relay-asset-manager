import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
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
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        const results: { id: string; success: boolean; error?: string }[] = [];

        for (const id of shortcutIds) {
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
                const { error: dbError } = await supabase
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
