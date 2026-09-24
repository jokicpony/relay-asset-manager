/**
 * Namer Folders API — Search Drive folders by name.
 * Replaces client-side `driveService.searchFolders()`.
 *
 * GET ?q=<query> — Returns: { folders: DriveFolder[] }
 * GET ?id=<folderId> — Returns folder metadata: { id, name, mimeType }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';
import { DRIVE_CALL_TIMEOUT_MS, namerErrorResponse } from '@/lib/namer/route-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Scope check (≤10s) + one Drive call (≤15s)
export const maxDuration = 30;

export async function GET(request: NextRequest) {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const query = searchParams.get('q');
        const folderId = searchParams.get('id');
        const token = await getDriveAccessToken();
        const config = await getConfig();

        // Single folder lookup by ID — bounded to the configured shared drive
        if (folderId) {
            if (!(await isInSharedDrive(token, folderId, config.sharedDriveId))) {
                return NextResponse.json({ error: 'Folder is outside the configured shared drive' }, { status: 403 });
            }
            const res = await fetch(
                `${DRIVE_API}/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`,
                { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS) }
            );
            if (!res.ok) {
                return NextResponse.json({ error: `Drive API error: ${res.status}` }, { status: res.status });
            }
            const folder = await res.json();
            return NextResponse.json(folder);
        }

        // Search folders by name
        if (!query) {
            return NextResponse.json({ error: 'q or id parameter is required' }, { status: 400 });
        }

        // Validate and sanitize query to prevent Drive query injection
        if (query.length > 200 || /[\\']/.test(query.replace(/[\w\s\-_.()]/g, ''))) {
            return NextResponse.json({ error: 'Invalid search query' }, { status: 400 });
        }
        const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

        const params = new URLSearchParams({
            q: `mimeType = 'application/vnd.google-apps.folder' and name contains '${escapedQuery}' and trashed = false`,
            fields: 'files(id,name,mimeType)',
            pageSize: '15',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
            corpora: 'drive',
            driveId: config.sharedDriveId,
        });

        const res = await fetch(`${DRIVE_API}/files?${params}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS),
        });

        if (!res.ok) {
            const err = await res.text();
            logger.error('namer-folders', 'Failed to search folders', { error: err, status: res.status });
            return NextResponse.json({ error: `Drive API error: ${res.status}`, details: err }, { status: res.status });
        }

        const data = await res.json();
        return NextResponse.json({ folders: data.files || [] });

    } catch (err: unknown) {
        return namerErrorResponse('namer-folders', err, 'Drive folder lookup');
    }
}
