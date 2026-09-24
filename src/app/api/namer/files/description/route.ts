/**
 * Namer File Description API — Set semantic search description on a Drive file.
 * Replaces `driveService.setDescription()`.
 *
 * POST body: { fileId, description }
 * Returns: { id, description }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { getConfig } from '@/lib/config';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { DRIVE_CALL_TIMEOUT_MS, namerErrorResponse } from '@/lib/namer/route-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

// One scope check (≤10s) + one PATCH (≤15s)
export const maxDuration = 30;

export async function POST(request: NextRequest) {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { fileId, description } = await request.json();
        if (!fileId || description === undefined) {
            return NextResponse.json({ error: 'fileId and description are required' }, { status: 400 });
        }

        const token = await getDriveAccessToken();

        // Bound the namer to the configured shared drive (see drive-scope).
        const { sharedDriveId } = await getConfig();
        if (!(await isInSharedDrive(token, fileId, sharedDriveId))) {
            return NextResponse.json({ error: 'File is outside the configured shared drive' }, { status: 403 });
        }

        const res = await fetch(
            `${DRIVE_API}/files/${fileId}?fields=id,description&supportsAllDrives=true`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ description }),
                signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS),
            }
        );

        if (!res.ok) {
            const err = await res.text();
            logger.error('namer-description', `Failed to set description on ${fileId}`, { error: err });
            return NextResponse.json({ error: `Drive API error: ${res.status}` }, { status: res.status });
        }

        const result = await res.json();
        return NextResponse.json(result);

    } catch (err: unknown) {
        return namerErrorResponse('namer-description', err, 'Setting the Drive description');
    }
}
