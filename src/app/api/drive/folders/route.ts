import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';
import { isInSharedDrive, DriveScopeUnavailableError } from '@/lib/google/drive-scope';

// Drive file/folder IDs are URL-safe base64-ish tokens. Validating before an
// ID reaches a Drive `q` expression prevents query injection (a crafted
// parentId could otherwise rewrite the query).
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

/**
 * GET /api/drive/folders?parentId=<folderId>
 *
 * Lists child folders of the given parent folder in the Shared Drive.
 * If parentId is omitted, lists root-level folders.
 *
 * Uses a service account (via WIF) for Drive access.
 */
export async function GET(request: NextRequest) {
    try {
        // Verify user is authenticated before touching config or Drive
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const config = await getConfig();
        const parentId = searchParams.get('parentId') || config.sharedDriveId;
        const search = searchParams.get('search');
        if (!DRIVE_ID_PATTERN.test(parentId)) {
            return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        const folders: { id: string; name: string; path?: string }[] = [];
        let pageToken: string | undefined;

        // If search query is provided, search across the entire shared drive
        if (search && search.trim()) {
            if (search.length > 200) {
                return NextResponse.json({ error: 'Search query too long' }, { status: 400 });
            }
            const searchTerm = search.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            do {
                const query = `name contains '${searchTerm}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
                const url = new URL('https://www.googleapis.com/drive/v3/files');
                url.searchParams.set('q', query);
                url.searchParams.set('fields', 'nextPageToken,files(id,name,parents)');
                url.searchParams.set('orderBy', 'name');
                url.searchParams.set('pageSize', '50');
                url.searchParams.set('supportsAllDrives', 'true');
                url.searchParams.set('includeItemsFromAllDrives', 'true');
                url.searchParams.set('corpora', 'drive');
                url.searchParams.set('driveId', config.sharedDriveId);
                if (pageToken) url.searchParams.set('pageToken', pageToken);

                const res = await fetch(url.toString(), {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });

                if (!res.ok) {
                    const errData = await res.json().catch(() => ({}));
                    return NextResponse.json(
                        { error: errData?.error?.message || `Drive API error: ${res.status}` },
                        { status: res.status }
                    );
                }

                const data = await res.json();
                for (const f of data.files || []) {
                    folders.push({ id: f.id, name: f.name });
                }
                pageToken = data.nextPageToken;
            } while (pageToken && folders.length < 50);

            return NextResponse.json({ folders, search: true });
        }

        // Standard: list child folders of the given parent
        do {
            const query = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
            const url = new URL('https://www.googleapis.com/drive/v3/files');
            url.searchParams.set('q', query);
            url.searchParams.set('fields', 'nextPageToken,files(id,name)');
            url.searchParams.set('orderBy', 'name');
            url.searchParams.set('pageSize', '100');
            url.searchParams.set('supportsAllDrives', 'true');
            url.searchParams.set('includeItemsFromAllDrives', 'true');
            url.searchParams.set('corpora', 'drive');
            url.searchParams.set('driveId', config.sharedDriveId);
            if (pageToken) url.searchParams.set('pageToken', pageToken);

            const res = await fetch(url.toString(), {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                return NextResponse.json(
                    { error: errData?.error?.message || `Drive API error: ${res.status}` },
                    { status: res.status }
                );
            }

            const data = await res.json();
            for (const f of data.files || []) {
                folders.push({ id: f.id, name: f.name });
            }
            pageToken = data.nextPageToken;
        } while (pageToken);

        return NextResponse.json({ folders, parentId });
    } catch (err) {
        if (err instanceof DriveScopeUnavailableError) {
            // Drive couldn't confirm the folder is in the shared drive (rate
            // limit / outage) — retryable, not a permissions problem
            return NextResponse.json({ error: err.message }, { status: 503 });
        }
        logger.error('drive', 'Folder listing error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to list folders' }, { status: 500 });
    }
}

/**
 * POST /api/drive/folders
 *
 * Creates a new folder inside the given parent folder on the Shared Drive.
 *
 * Uses a service account (via WIF) for Drive access.
 *
 * Body: { parentId: string, name: string }
 */
export async function POST(request: NextRequest) {
    try {
        const { parentId, name } = await request.json() as {
            parentId: string;
            name: string;
        };

        if (typeof name !== 'string' || !name.trim()) {
            return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
        }
        if (name.trim().length > 255) {
            return NextResponse.json({ error: 'Folder name is too long' }, { status: 400 });
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        const foldersConfig = await getConfig();
        const targetParent = parentId || foldersConfig.sharedDriveId;
        if (!DRIVE_ID_PATTERN.test(targetParent)) {
            return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
        }
        // The service account can reach more than the library's shared drive —
        // only create folders inside it (same guard as relays).
        if (!(await isInSharedDrive(accessToken, targetParent, foldersConfig.sharedDriveId))) {
            return NextResponse.json({ error: 'Parent folder is outside the shared drive' }, { status: 403 });
        }

        const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: name.trim(),
                mimeType: 'application/vnd.google-apps.folder',
                parents: [targetParent],
            }),
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            return NextResponse.json(
                { error: errData?.error?.message || `Drive API error: ${res.status}` },
                { status: res.status }
            );
        }

        const created = await res.json();
        return NextResponse.json({ id: created.id, name: created.name });
    } catch (err) {
        if (err instanceof DriveScopeUnavailableError) {
            // Drive couldn't confirm the folder is in the shared drive (rate
            // limit / outage) — retryable, not a permissions problem
            return NextResponse.json({ error: err.message }, { status: 503 });
        }
        logger.error('drive', 'Folder creation error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to create folder' }, { status: 500 });
    }
}
