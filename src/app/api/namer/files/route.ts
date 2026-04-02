/**
 * Namer Files API — List media files in a Google Drive folder.
 * Replaces the client-side `driveService.listFiles()`.
 *
 * POST body: { folderId: string }
 * Returns: { files: NamerFile[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import type { NamerFile } from '@/lib/namer/types';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

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

        // First check if it's a folder or a file
        const metaRes = await fetch(
            `${DRIVE_API}/files/${folderId}?fields=id,name,mimeType,parents,thumbnailLink,imageMediaMetadata,videoMediaMetadata&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${token}` } }
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

        do {
            const params = new URLSearchParams({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'nextPageToken,files(id,name,mimeType,parents,thumbnailLink,imageMediaMetadata,videoMediaMetadata,size,createdTime)',
                pageSize: '1000',
                supportsAllDrives: 'true',
                includeItemsFromAllDrives: 'true',
            });
            if (pageToken) params.set('pageToken', pageToken);

            const listRes = await fetch(`${DRIVE_API}/files?${params}`, {
                headers: { Authorization: `Bearer ${token}` },
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
        const message = err instanceof Error ? err.message : String(err);
        logger.error('namer-files', 'Unexpected error', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
