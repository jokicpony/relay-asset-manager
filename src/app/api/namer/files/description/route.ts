/**
 * Namer File Description API — Set semantic search description on a Drive file.
 * Replaces `driveService.setDescription()`.
 *
 * POST body: { fileId, description }
 * Returns: { id, description }
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
        const { fileId, description } = await request.json();
        if (!fileId || description === undefined) {
            return NextResponse.json({ error: 'fileId and description are required' }, { status: 400 });
        }

        const token = await getDriveAccessToken();

        const res = await fetch(
            `${DRIVE_API}/files/${fileId}?fields=id,description&supportsAllDrives=true`,
            {
                method: 'PATCH',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ description }),
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
        const message = err instanceof Error ? err.message : String(err);
        logger.error('namer-description', 'Unexpected error', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
