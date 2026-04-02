/**
 * Namer File Update API — Rename + Move a file atomically.
 * Replaces `driveService.updateFile()`.
 *
 * POST body: { fileId, newName, destFolderId, sourceFolderId }
 * Returns: { id, name, parents }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

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
        });

        if (!res.ok) {
            const err = await res.text();
            logger.error('namer-update', `Failed to update file ${fileId}`, { error: err });
            return NextResponse.json({ error: `Drive API error: ${res.status}` }, { status: res.status });
        }

        const result = await res.json();
        logger.info('namer-update', `Renamed ${fileId} → ${newName}`);
        return NextResponse.json(result);

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('namer-update', 'Unexpected error', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
