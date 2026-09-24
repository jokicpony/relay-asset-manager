/**
 * Sync Scope Check API — Is a folder within the DAM's sync scope?
 *
 * GET /api/sync/scope?folderId=XXX
 *
 * Checks the cached folder_drive_ids mapping from app_settings to determine
 * if a given folder ID falls under one of the configured syncFolders.
 * Falls back to a live Drive API lookup if the cache misses.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { getConfig } from '@/lib/config';
import { isInSharedDrive, isDriveId, DriveScopeUnavailableError } from '@/lib/google/drive-scope';
import { resolveFolderPathById } from '@/lib/google/folder-path';
import { normalizeSyncFolders, isInSyncScope } from '@/lib/sync/scope';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const maxDuration = 30;

export async function GET(request: NextRequest) {
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get('folderId');

    if (!folderId || !isDriveId(folderId)) {
        return NextResponse.json({ error: 'A valid folderId is required' }, { status: 400 });
    }

    try {
        const config = await getConfig();
        const syncFolders = normalizeSyncFolders(config.syncFolders);

        // No sync folders configured = everything is in scope
        if (syncFolders.length === 0) {
            return NextResponse.json({ inScope: true, folderPath: null, source: 'no-filter' });
        }

        // 1. Check the cached folder_drive_ids mapping first (no API call needed)
        const supabase = getAdminClient();

        const { data: mappingRow } = await supabase
            .from('app_settings')
            .select('value')
            .eq('key', 'folder_drive_ids')
            .single();

        if (mappingRow?.value) {
            const folderIdMap = mappingRow.value as Record<string, string>;

            // Invert: check if our folderId appears as a value
            for (const [path, id] of Object.entries(folderIdMap)) {
                if (id === folderId) {
                    const inScope = isInSyncScope(path, syncFolders);
                    return NextResponse.json({ inScope, folderPath: path, source: 'cache' });
                }
            }
        }

        // 2. Cache miss — resolve from Drive, but only for folders inside the
        // shared drive (the service account can see more; walking an outside
        // folder's parents would reveal names from other drives).
        logger.info('scope-check', `Cache miss for folder ${folderId}, resolving from Drive`);
        const accessToken = await getDriveAccessToken();
        if (!(await isInSharedDrive(accessToken, folderId, config.sharedDriveId))) {
            return NextResponse.json({ inScope: false, folderPath: null, source: 'outside-shared-drive' });
        }

        const { path: folderPath } = await resolveFolderPathById(accessToken, folderId, config.sharedDriveId);
        const inScope = folderPath !== '/unknown' && isInSyncScope(folderPath, syncFolders);

        return NextResponse.json({ inScope, folderPath, source: 'drive-api' });

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DriveScopeUnavailableError) {
            return NextResponse.json({ error: message }, { status: 503 });
        }
        logger.error('scope-check', 'Scope check failed', { error: message });
        return NextResponse.json({ error: 'Scope check failed' }, { status: 500 });
    }
}
