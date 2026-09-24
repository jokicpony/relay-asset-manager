/**
 * Namer Files API — List media files in a Google Drive folder.
 * Replaces the client-side `driveService.listFiles()`.
 *
 * POST body: { folderId: string }
 * Returns: { files: NamerFile[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { getConfig } from '@/lib/config';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { NamerFile } from '@/lib/namer/types';
import { DRIVE_CALL_TIMEOUT_MS, namerErrorResponse } from '@/lib/namer/route-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Scope check (≤10s) + metadata (≤15s) + paged listing (≤30s in total)
export const maxDuration = 60;
const LISTING_TIMEOUT_MS = 30_000;

export async function POST(request: NextRequest) {
    // Auth check
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { folderId } = await request.json();
        if (!folderId) {
            return NextResponse.json({ error: 'folderId is required' }, { status: 400 });
        }

        const token = await getDriveAccessToken();

        // Bound the namer to the configured shared drive (see drive-scope).
        const { sharedDriveId } = await getConfig();
        if (!(await isInSharedDrive(token, folderId, sharedDriveId))) {
            return NextResponse.json({ error: 'Folder is outside the configured shared drive' }, { status: 403 });
        }

        // First check if it's a folder or a file
        const metaRes = await fetch(
            `${DRIVE_API}/files/${folderId}?fields=id,name,mimeType,parents,thumbnailLink,imageMediaMetadata,videoMediaMetadata&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS) }
        );

        if (!metaRes.ok) {
            const err = await metaRes.text();
            logger.error('namer-files', 'Failed to get resource metadata', { error: err });
            return NextResponse.json({ error: `Drive API error: ${metaRes.status}` }, { status: metaRes.status });
        }

        const resource = await metaRes.json();

        // If it's a single file, return it directly
        if (resource.mimeType !== 'application/vnd.google-apps.folder') {
            const file: NamerFile = {
                id: resource.id,
                name: resource.name,
                mimeType: resource.mimeType,
                parents: resource.parents,
                thumbnailLink: resource.thumbnailLink,
                imageMediaMetadata: resource.imageMediaMetadata,
                videoMediaMetadata: resource.videoMediaMetadata,
            };
            return NextResponse.json({ files: [file] });
        }

        // It's a folder — list all media files inside
        const files: NamerFile[] = [];
        let pageToken: string | undefined;
        // One deadline across all pages, so a huge folder can't outrun maxDuration
        const listingSignal = AbortSignal.timeout(LISTING_TIMEOUT_MS);

        do {
            const params = new URLSearchParams({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'nextPageToken,files(id,name,mimeType,parents,thumbnailLink,imageMediaMetadata,videoMediaMetadata,size,createdTime)',
                pageSize: '1000',
                // The namer's counter numbers files in list order, so the order
                // must be predictable. name_natural matches what people see in
                // Drive/Finder and keeps camera sequences (IMG_2 < IMG_10) in
                // shooting order. createdTime was the alternative, but in Drive
                // it's the upload time — parallel uploads scramble it.
                orderBy: 'name_natural',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });
            if (pageToken) params.set('pageToken', pageToken);

            const listRes = await fetch(`${DRIVE_API}/files?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: listingSignal,
            });

            if (!listRes.ok) {
                const err = await listRes.text();
                logger.error('namer-files', 'Failed to list files', { error: err });
                return NextResponse.json({ error: `Drive API error: ${listRes.status}` }, { status: listRes.status });
            }

            const data = await listRes.json();
            pageToken = data.nextPageToken;

            // Filter for photos and videos only
            for (const f of data.files || []) {
                if (f.mimeType?.startsWith('image/') || f.mimeType?.startsWith('video/')) {
                    files.push({
                        id: f.id,
                        name: f.name,
                        mimeType: f.mimeType,
                        parents: f.parents,
                        thumbnailLink: f.thumbnailLink,
                        imageMediaMetadata: f.imageMediaMetadata,
                        videoMediaMetadata: f.videoMediaMetadata,
                        size: f.size,
                        createdTime: f.createdTime,
                    });
                }
            }
        } while (pageToken);

        logger.info('namer-files', `Listed ${files.length} media files from folder ${folderId}`);
        return NextResponse.json({ files });

    } catch (err: unknown) {
        return namerErrorResponse('namer-files', err, 'Listing the Drive folder');
    }
}
