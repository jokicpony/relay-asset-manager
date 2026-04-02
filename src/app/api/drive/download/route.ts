import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';

/**
 * POST /api/drive/download
 *
 * Downloads multiple Google Drive files as a streaming zip archive.
 * Unlike the old approach, this streams data to the browser as each file
 * is fetched — no buffering everything in memory first.
 *
 * For a single file, redirects to the GET streaming endpoint instead.
 *
 * Uses a service account (via WIF) for Drive access.
 *
 * Body: { files: { driveFileId: string, name: string }[] }
 */
export async function POST(request: NextRequest) {
    try {
        const { files } = await request.json() as {
            files: { driveFileId: string; name: string }[];
        };

        if (!files || files.length === 0) {
            return NextResponse.json({ error: 'No files specified' }, { status: 400 });
        }

        // Single file — redirect to the streaming GET endpoint
        if (files.length === 1) {
            const file = files[0];
            const url = new URL(
                `/api/drive/download/${file.driveFileId}`,
                request.nextUrl.origin
            );
            url.searchParams.set('name', file.name);
            return NextResponse.redirect(url);
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        // Build a streaming zip response
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                const centralDirectory: Uint8Array[] = [];
                let offset = 0;

                for (const file of files) {
                    try {
                        const driveUrl = `https://www.googleapis.com/drive/v3/files/${file.driveFileId}?alt=media&supportsAllDrives=true`;
                        const driveRes = await fetch(driveUrl, {
                            headers: { Authorization: `Bearer ${accessToken}` },
                        });

                        if (!driveRes.ok) {
                            logger.warn('download-zip', `Skipping ${file.name}: Drive ${driveRes.status}`);
                            continue;
                        }

                        // We need the full data for CRC-32 calculation
                        // For files within a zip, we fetch them individually (they're photos, not huge videos)
                        const data = new Uint8Array(await driveRes.arrayBuffer());
                        const fileName = encoder.encode(file.name);
                        const crc = crc32(data);

                        // Local file header (30 bytes + filename)
                        const localHeader = new Uint8Array(30 + fileName.length);
                        const lv = new DataView(localHeader.buffer);
                        lv.setUint32(0, 0x04034b50, true);   // signature
                        lv.setUint16(4, 20, true);             // version needed
                        lv.setUint16(6, 0, true);              // flags
                        lv.setUint16(8, 0, true);              // compression: stored
                        lv.setUint16(10, 0, true);             // mod time
                        lv.setUint16(12, 0, true);             // mod date
                        lv.setUint32(14, crc, true);           // CRC-32
                        lv.setUint32(18, data.length, true);   // compressed size
                        lv.setUint32(22, data.length, true);   // uncompressed size
                        lv.setUint16(26, fileName.length, true);
                        lv.setUint16(28, 0, true);             // extra field length
                        localHeader.set(fileName, 30);

                        // Central directory entry (46 bytes + filename)
                        const cdEntry = new Uint8Array(46 + fileName.length);
                        const cv = new DataView(cdEntry.buffer);
                        cv.setUint32(0, 0x02014b50, true);
                        cv.setUint16(4, 20, true);
                        cv.setUint16(6, 20, true);
                        cv.setUint16(8, 0, true);
                        cv.setUint16(10, 0, true);
                        cv.setUint16(12, 0, true);
                        cv.setUint16(14, 0, true);
                        cv.setUint32(16, crc, true);
                        cv.setUint32(20, data.length, true);
                        cv.setUint32(24, data.length, true);
                        cv.setUint16(28, fileName.length, true);
                        cv.setUint16(30, 0, true);
                        cv.setUint16(32, 0, true);
                        cv.setUint16(34, 0, true);
                        cv.setUint16(36, 0, true);
                        cv.setUint32(38, 0, true);
                        cv.setUint32(42, offset, true);
                        cdEntry.set(fileName, 46);
                        centralDirectory.push(cdEntry);

                        // Enqueue the local header + data immediately (streaming!)
                        controller.enqueue(localHeader);
                        controller.enqueue(data);
                        offset += localHeader.length + data.length;
                    } catch (err) {
                        logger.warn('download-zip', `Skipping ${file.name}: ${String(err)}`);
                        continue;
                    }
                }

                // Write central directory
                for (const cd of centralDirectory) {
                    controller.enqueue(cd);
                }

                // End of central directory record (22 bytes)
                const cdSize = centralDirectory.reduce((sum, e) => sum + e.length, 0);
                const eocd = new Uint8Array(22);
                const ev = new DataView(eocd.buffer);
                ev.setUint32(0, 0x06054b50, true);
                ev.setUint16(4, 0, true);
                ev.setUint16(6, 0, true);
                ev.setUint16(8, centralDirectory.length, true);
                ev.setUint16(10, centralDirectory.length, true);
                ev.setUint32(12, cdSize, true);
                ev.setUint32(16, offset, true);
                ev.setUint16(20, 0, true);
                controller.enqueue(eocd);

                controller.close();
            },
        });

        // Timestamp the zip so browsers don't block successive downloads as duplicates
        const now = new Date();
        const ts = now.getFullYear().toString()
            + String(now.getMonth() + 1).padStart(2, '0')
            + String(now.getDate()).padStart(2, '0')
            + '-'
            + String(now.getHours()).padStart(2, '0')
            + String(now.getMinutes()).padStart(2, '0')
            + String(now.getSeconds()).padStart(2, '0');

        const headers = new Headers();
        headers.set('Content-Type', 'application/zip');
        headers.set('Content-Disposition', `attachment; filename="relay-assets-${ts}.zip"`);
        // No Content-Length — we're streaming and don't know total size upfront

        return new NextResponse(stream, { status: 200, headers });
    } catch (err) {
        logger.error('download-zip', 'Download error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to download files' }, { status: 500 });
    }
}

// -----------------------------------------------------------------------
// CRC-32 implementation (needed for zip file format)
// -----------------------------------------------------------------------
function crc32(data: Uint8Array): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
