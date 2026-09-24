import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';

/**
 * GET /api/drive/stream/[fileId]
 *
 * Proxies a Google Drive file download as a streamable video response.
 * Uses a service account (via WIF) for Drive access.
 * Supports Range requests for video seeking.
 */
// Each range request streams one chunk; the limit bounds a slow one
export const maxDuration = 300;

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ fileId: string }> }
) {
    const { fileId } = await params;

    try {
        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Authorization: only stream files that are part of the curated,
        // in-scope library. The service account can read the entire shared
        // drive, so without this check any authenticated user could stream
        // arbitrary Drive files by ID (confused-deputy / IDOR).
        const { data: assetRow } = await supabase
            .from('assets')
            .select('id')
            .eq('drive_file_id', fileId)
            .eq('is_active', true)
            .maybeSingle();

        if (!assetRow) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        // Proxy the request to Google Drive API
        const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;

        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
        };

        // Forward Range header for video seeking
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
            headers['Range'] = rangeHeader;
        }

        const driveRes = await fetch(driveUrl, { headers });

        if (!driveRes.ok) {
            return NextResponse.json(
                { error: `Drive API error: ${driveRes.status}` },
                { status: driveRes.status }
            );
        }

        // Build response headers
        const responseHeaders = new Headers();
        const contentType = driveRes.headers.get('content-type') || 'video/mp4';
        responseHeaders.set('Content-Type', contentType);

        const contentLength = driveRes.headers.get('content-length');
        if (contentLength) {
            responseHeaders.set('Content-Length', contentLength);
        }

        const contentRange = driveRes.headers.get('content-range');
        if (contentRange) {
            responseHeaders.set('Content-Range', contentRange);
        }

        responseHeaders.set('Accept-Ranges', 'bytes');
        responseHeaders.set('Cache-Control', 'private, max-age=3600');
        // Served inline on the app's origin: never let a mislabeled upload be
        // sniffed into HTML, and sandbox it if opened directly
        responseHeaders.set('X-Content-Type-Options', 'nosniff');
        responseHeaders.set('Content-Security-Policy', 'sandbox');

        return new NextResponse(driveRes.body, {
            status: driveRes.status,
            headers: responseHeaders,
        });
    } catch (err) {
        logger.error('stream', 'Drive stream error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to stream file' }, { status: 500 });
    }
}
