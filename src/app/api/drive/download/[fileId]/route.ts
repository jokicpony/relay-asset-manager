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
// Single files stream Drive → browser through this function; the download
// preflight refuses files too large to finish inside this limit.
export const maxDuration = 300;

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ fileId: string }> }
) {
    const { fileId } = await params;
    const name = request.nextUrl.searchParams.get('name') || 'download';

    try {
        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Authorization: only serve files that are part of the curated,
        // in-scope library. The service account can read the entire shared
        // drive, so without this check any authenticated user could pull
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
        headers.set('Content-Disposition', contentDisposition(name));
        headers.set('X-Content-Type-Options', 'nosniff');

        const contentLength = driveRes.headers.get('content-length');
        if (contentLength) headers.set('Content-Length', contentLength);

        return new NextResponse(driveRes.body, { status: 200, headers });
    } catch (err) {
        logger.error('download-stream', 'Stream error', { error: String(err), fileId });
        return NextResponse.json({ error: 'Failed to download file' }, { status: 500 });
    }
}

/**
 * RFC 6266 attachment header. `name` comes from the request, so the plain
 * `filename` is reduced to safe printable ASCII (no quotes, backslashes or
 * control characters — nothing that could break out of the header), and
 * `filename*` carries the real UTF-8 name. The old percent-encoded
 * `filename="…"` made browsers save "My%20Photo.jpg".
 */
function contentDisposition(name: string): string {
    const ascii = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '_').trim() || 'download';
    const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}
