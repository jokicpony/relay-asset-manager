import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';

/**
 * GET /api/drive/download/[fileId]?name=filename.mov
 *
 * Streams a single Google Drive file directly to the browser as an attachment
 * download. The browser's native download manager takes over — no buffering,
 * instant start, and the user can navigate away safely.
 *
 * Uses a service account (via WIF) for Drive access.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ fileId: string }> }
) {
    const { fileId } = await params;
    const name = request.nextUrl.searchParams.get('name') || 'download';

    try {
        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        // Fetch file from Google Drive
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
        const driveRes = await fetch(driveUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!driveRes.ok) {
            logger.error('download-stream', `Drive API error: ${driveRes.status}`, { fileId });
            return NextResponse.json(
                { error: `Drive API error: ${driveRes.status}` },
                { status: driveRes.status }
            );
        }

        // Stream directly to browser — no buffering
        const headers = new Headers();
        const contentType = driveRes.headers.get('content-type') || 'application/octet-stream';
        headers.set('Content-Type', contentType);
        headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);

        const contentLength = driveRes.headers.get('content-length');
        if (contentLength) headers.set('Content-Length', contentLength);

        return new NextResponse(driveRes.body, { status: 200, headers });
    } catch (err) {
        logger.error('download-stream', 'Stream error', { error: String(err), fileId });
        return NextResponse.json({ error: 'Failed to download file' }, { status: 500 });
    }
}
