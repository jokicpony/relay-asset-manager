/**
 * Namer File Update API — Rename + Move a file atomically.
 * Replaces `driveService.updateFile()`.
 *
 * POST body: { fileId, newName, destFolderId, sourceFolderId }
 * Returns: { id, name, parents }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { getConfig } from '@/lib/config';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { DRIVE_CALL_TIMEOUT_MS, namerErrorResponse } from '@/lib/namer/route-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Two scope checks (≤10s each) + one PATCH (≤15s)
export const maxDuration = 60;

export async function POST(request: NextRequest) {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { fileId, newName, destFolderId, sourceFolderId } = await request.json();
        if (!fileId || !newName || !destFolderId) {
            return NextResponse.json(
                { error: 'fileId, newName, and destFolderId are required' },
                { status: 400 }
            );
        }

        const token = await getDriveAccessToken();

        // Bound the namer to the configured shared drive: both the file and its
        // destination must live inside it (prevents reading/moving files out).
        const { sharedDriveId } = await getConfig();
        if (!(await isInSharedDrive(token, fileId, sharedDriveId))) {
            return NextResponse.json({ error: 'File is outside the configured shared drive' }, { status: 403 });
        }
        if (!(await isInSharedDrive(token, destFolderId, sharedDriveId))) {
            return NextResponse.json({ error: 'Destination is outside the configured shared drive' }, { status: 403 });
        }

        const params = new URLSearchParams({
            addParents: destFolderId,
            fields: 'id,name,parents',
            supportsAllDrives: 'true',
        });
        if (sourceFolderId) {
            params.set('removeParents', sourceFolderId);
        }

        const res = await fetch(`${DRIVE_API}/files/${fileId}?${params}`, {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: newName }),
            signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS),
        });

        if (!res.ok) {
            const err = await res.text();
            logger.error('namer-update', `Failed to update file ${fileId}`, { error: err });
            // Drive's own sentence (e.g. "File not found") is what the queue shows
            let driveMessage = '';
            try {
                driveMessage = (JSON.parse(err) as { error?: { message?: string } }).error?.message ?? '';
            } catch {
                // non-JSON body — status alone
            }
            return NextResponse.json(
                { error: `Drive API error ${res.status}${driveMessage ? `: ${driveMessage}` : ''}` },
                { status: res.status }
            );
        }

        const result = await res.json();
        logger.info('namer-update', `Renamed ${fileId} → ${newName}`);
        return NextResponse.json(result);

    } catch (err: unknown) {
        return namerErrorResponse('namer-update', err, 'Drive rename/move');
    }
}
