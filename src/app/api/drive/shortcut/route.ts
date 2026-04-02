import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';

/**
 * POST /api/drive/shortcut
 *
 * Creates Google Drive shortcuts for the given assets in a target folder.
 * Also records each shortcut in the Supabase `shortcuts` table.
 *
 * Uses a service account (via WIF) for Drive access.
 *
 * Body: {
 *   assets: { driveFileId: string, assetId: string, name: string }[],
 *   targetFolderId: string,
 *   targetFolderPath: string
 * }
 */
export async function POST(request: NextRequest) {
    try {
        const { assets, targetFolderId, targetFolderPath } = await request.json() as {
            assets: { driveFileId: string; assetId: string; name: string }[];
            targetFolderId: string;
            targetFolderPath: string;
        };

        if (!assets || assets.length === 0) {
            return NextResponse.json({ error: 'No assets specified' }, { status: 400 });
        }
        if (!targetFolderId || !targetFolderPath) {
            return NextResponse.json({ error: 'No target folder specified' }, { status: 400 });
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        const results: { name: string; success: boolean; shortcutId?: string; error?: string }[] = [];

        for (const asset of assets) {
            try {
                // Create the Google Drive shortcut
                const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        name: asset.name,
                        mimeType: 'application/vnd.google-apps.shortcut',
                        parents: [targetFolderId],
                        shortcutDetails: {
                            targetId: asset.driveFileId,
                        },
                    }),
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    const msg = errData?.error?.message || `HTTP ${res.status}`;
                    results.push({ name: asset.name, success: false, error: msg });
                    continue;
                }

                const created = await res.json();

                // Record in Supabase shortcuts table
                const { error: dbError } = await supabase
                    .from('shortcuts')
                    .insert({
                        shortcut_drive_id: created.id,
                        target_asset_id: asset.assetId,
                        project_folder_path: targetFolderPath,
                        project_folder_drive_id: targetFolderId,
                    });

                if (dbError) {
                    logger.warn('shortcut', `DB insert failed for ${asset.name}`, { error: dbError.message });
                    // Still counts as success — the Drive shortcut was created
                }

                results.push({ name: asset.name, success: true, shortcutId: created.id });
            } catch (err) {
                results.push({
                    name: asset.name,
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                });
            }
        }

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;

        return NextResponse.json({
            succeeded,
            failed,
            total: assets.length,
            results,
        });
    } catch (err) {
        logger.error('shortcut', 'Shortcut creation error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to create shortcuts' }, { status: 500 });
    }
}
