import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { resolveFolderPathById } from '@/lib/google/folder-path';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * GET /api/drive/folders/path?folderId=<folderId>
 *
 * Resolves a Drive folder ID to its full canonical path and breadcrumb chain.
 * Used by the folder picker to rebuild the breadcrumb when the user enters a
 * folder via search or "recent" — both code paths only know the leaf folder
 * and would otherwise produce a truncated path.
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const folderId = searchParams.get('folderId');

        if (!folderId) {
            return NextResponse.json({ error: 'folderId is required' }, { status: 400 });
        }

        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        const accessToken = await getDriveAccessToken();
        const config = await getConfig();
        const { path, breadcrumbs } = await resolveFolderPathById(
            accessToken,
            folderId,
            config.sharedDriveId
        );

        return NextResponse.json({ path, breadcrumbs });
    } catch (err) {
        logger.error('drive', 'Folder path resolution error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to resolve folder path' }, { status: 500 });
    }
}
