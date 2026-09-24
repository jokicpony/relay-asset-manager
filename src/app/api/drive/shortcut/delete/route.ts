import { NextRequest, NextResponse } from 'next/server';
import { isDriveId } from '@/lib/google/drive-scope';
import { createClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
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
export const maxDuration = 120;

export async function DELETE(request: NextRequest) {
    try {
        const { shortcutIds } = await request.json() as { shortcutIds: string[] };

        if (!Array.isArray(shortcutIds) || shortcutIds.length === 0) {
            return NextResponse.json({ error: 'No shortcut IDs specified' }, { status: 400 });
        }
        // Relays are capped at 500 per request, so their undo is too
        if (shortcutIds.length > 500 || !shortcutIds.every(isDriveId)) {
            return NextResponse.json({ error: 'shortcutIds must be at most 500 valid Drive IDs' }, { status: 400 });
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
        const admin = getAdminClient();

        // Authorization: only delete Drive files that are tracked shortcuts.
        // The service account can delete anything it can reach, so without this
        // check any authenticated user could delete arbitrary Drive files by ID.
        // (A failed lookup must be an error — ignoring it reported every ID as
        // "Not a tracked shortcut" with a 200. Batched for URL length.)
        const knownIds = new Set<string>();
        for (let i = 0; i < shortcutIds.length; i += 150) {
            const { data: knownRows, error: lookupErr } = await admin
                .from('shortcuts')
                .select('shortcut_drive_id')
                .in('shortcut_drive_id', shortcutIds.slice(i, i + 150));
            if (lookupErr) {
                return NextResponse.json({ error: 'Failed to verify shortcuts' }, { status: 500 });
            }
            for (const r of knownRows ?? []) knownIds.add(r.shortcut_drive_id);
        }

        const results: { id: string; success: boolean; untracked?: boolean; error?: string }[] = [];

        for (const id of shortcutIds) {
            if (!knownIds.has(id)) {
                // Nothing is deleted (authorization), but tell the client —
                // an untracked ID is usually one already removed (by an
                // earlier undo, the sync's cleanup, or a purged target).
                results.push({ id, success: false, untracked: true, error: 'Not a tracked shortcut' });
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
