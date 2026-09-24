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
import { google } from 'googleapis';
import { getDriveAccessToken } from '@/lib/google/auth';
import { getConfig } from '@/lib/config';
import { normalizeSyncFolders, isInSyncScope } from '@/lib/sync/scope';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const folderId = searchParams.get('folderId');

    if (!folderId) {
        return NextResponse.json({ error: 'folderId is required' }, { status: 400 });
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

        // 2. Cache miss — resolve folder path from Drive API
        logger.info('scope-check', `Cache miss for folder ${folderId}, resolving from Drive`);

        const accessToken = await getDriveAccessToken();
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: accessToken });
        const drive = google.drive({ version: 'v3', auth });
        const driveId = config.sharedDriveId;

        // Walk up the parent chain to build the full path
        let currentId = folderId;
        const pathParts: string[] = [];

        while (currentId && currentId !== driveId) {
            try {
                const res = await drive.files.get({
                    fileId: currentId,
                    fields: 'id,name,parents',
                    supportsAllDrives: true,
                });

                pathParts.unshift(res.data.name || 'unknown');
                currentId = res.data.parents?.[0] || '';
            } catch {
                break;
            }
        }

        const folderPath = '/' + pathParts.join('/');
        const inScope = isInSyncScope(folderPath, syncFolders);

        return NextResponse.json({ inScope, folderPath, source: 'drive-api' });

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('scope-check', 'Scope check failed', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
