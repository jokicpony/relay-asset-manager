import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { resolveFolderPathById } from '@/lib/google/folder-path';
import { getConfig } from '@/lib/config';
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
 * }
 *
 * `targetFolderPath` is resolved server-side from `targetFolderId` so that
 * shortcut rows always carry the full canonical path, regardless of how the
 * client built its breadcrumb.
 */
export async function POST(request: NextRequest) {
    try {
        const { assets, targetFolderId } = await request.json() as {
            assets: { driveFileId: string; assetId: string; name: string }[];
            targetFolderId: string;
        };

        if (!assets || assets.length === 0) {
            return NextResponse.json({ error: 'No assets specified' }, { status: 400 });
        }
        if (!targetFolderId) {
            return NextResponse.json({ error: 'No target folder specified' }, { status: 400 });
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        // Shortcut rows are written with the service role — RLS allows only
        // service-role writes to the shortcuts table; the user client above is
        // used only for the auth check.
        const admin = createServiceClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        // Authorization: the target folder must live in the configured shared
        // drive — the service account may reach other drives, but shortcuts
        // must not be plantable outside the DAM.
        const config = await getConfig();
        if (!(await isInSharedDrive(accessToken, targetFolderId, config.sharedDriveId))) {
            return NextResponse.json(
                { error: 'Target folder is outside the configured shared drive' },
                { status: 403 }
            );
        }

        // Authorization: only shortcut files that exist as active library
        // assets. Resolve the asset UUID server-side from drive_file_id —
        // never trust the client-supplied assetId (confused-deputy / IDOR).
        const { data: assetRows } = await admin
            .from('assets')
            .select('id, drive_file_id')
            .in('drive_file_id', assets.map((a) => a.driveFileId))
            .eq('is_active', true);
        const assetIdByDriveId = new Map(
            (assetRows ?? []).map((r) => [r.drive_file_id, r.id])
        );

        // Resolve the canonical folder path from the Drive folder ID. This is
        // the source-of-truth value written into shortcuts.project_folder_path —
        // never trust whatever path string the client constructed.
        const { path: targetFolderPath } = await resolveFolderPathById(
            accessToken,
            targetFolderId,
            config.sharedDriveId
        );

        if (targetFolderPath === '/unknown') {
            return NextResponse.json(
                { error: 'Could not resolve target folder path' },
                { status: 400 }
            );
        }

        const results: { name: string; success: boolean; shortcutId?: string; error?: string }[] = [];

        for (const asset of assets) {
            const libraryAssetId = assetIdByDriveId.get(asset.driveFileId);
            if (!libraryAssetId) {
                results.push({ name: asset.name, success: false, error: 'Not an active library asset' });
                continue;
            }
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
                const { error: dbError } = await admin
                    .from('shortcuts')
                    .insert({
                        shortcut_drive_id: created.id,
                        target_asset_id: libraryAssetId,
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
            resolvedFolderPath: targetFolderPath,
        });
    } catch (err) {
        logger.error('shortcut', 'Shortcut creation error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to create shortcuts' }, { status: 500 });
    }
}
