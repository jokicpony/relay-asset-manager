import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive, DriveScopeUnavailableError } from '@/lib/google/drive-scope';
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
export const maxDuration = 120;

const MAX_ASSETS_PER_RELAY = 500;
const RELAY_CONCURRENCY = 5;

export async function POST(request: NextRequest) {
    try {
        const { assets, targetFolderId } = await request.json() as {
            assets: { driveFileId: string; assetId: string; name: string }[];
            targetFolderId: string;
        };

        if (!Array.isArray(assets) || assets.length === 0) {
            return NextResponse.json({ error: 'No assets specified' }, { status: 400 });
        }
        if (assets.length > MAX_ASSETS_PER_RELAY) {
            return NextResponse.json(
                { error: `Relay at most ${MAX_ASSETS_PER_RELAY} assets at a time` },
                { status: 400 }
            );
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
        const admin = getAdminClient();

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
        // (Batched: long .in() lists overflow URL limits.)
        const assetIdByDriveId = new Map<string, string>();
        const driveIds = assets.map((a) => a.driveFileId);
        for (let i = 0; i < driveIds.length; i += 150) {
            const { data: assetRows, error: lookupErr } = await admin
                .from('assets')
                .select('id, drive_file_id')
                .in('drive_file_id', driveIds.slice(i, i + 150))
                .eq('is_active', true);
            if (lookupErr) {
                return NextResponse.json({ error: 'Failed to verify assets' }, { status: 500 });
            }
            for (const r of assetRows ?? []) assetIdByDriveId.set(r.drive_file_id, r.id);
        }

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

        type RelayResult = { name: string; success: boolean; shortcutId?: string; error?: string };

        const relayOne = async (asset: typeof assets[number]): Promise<RelayResult> => {
            const libraryAssetId = assetIdByDriveId.get(asset.driveFileId);
            if (!libraryAssetId) {
                return { name: asset.name, success: false, error: 'Not an active library asset' };
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
                    return { name: asset.name, success: false, error: msg };
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
                    // An untracked shortcut can't be undone from the app (the
                    // delete route only removes tracked shortcuts) and shows no
                    // relay badge — roll it back and report the failure.
                    logger.warn('shortcut', `DB insert failed for ${asset.name}; rolling back`, { error: dbError.message });
                    await fetch(
                        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(created.id)}?supportsAllDrives=true`,
                        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
                    ).catch(() => { /* next sync will pick it up if this fails */ });
                    return { name: asset.name, success: false, error: 'Could not record relay' };
                }

                return { name: asset.name, success: true, shortcutId: created.id };
            } catch (err) {
                return {
                    name: asset.name,
                    success: false,
                    error: err instanceof Error ? err.message : 'Unknown error',
                };
            }
        };

        // Small bounded pool instead of strictly sequential Drive POSTs, so
        // large relays finish well inside the function timeout. Results keep
        // request order.
        const results: RelayResult[] = new Array(assets.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(RELAY_CONCURRENCY, assets.length) }, async () => {
            while (next < assets.length) {
                const i = next++;
                results[i] = await relayOne(assets[i]);
            }
        }));

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
        if (err instanceof DriveScopeUnavailableError) {
            // Drive couldn't confirm the folder is in the shared drive (rate
            // limit / outage) — retryable, not a permissions problem
            return NextResponse.json({ error: err.message }, { status: 503 });
        }
        logger.error('shortcut', 'Shortcut creation error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to create shortcuts' }, { status: 500 });
    }
}
