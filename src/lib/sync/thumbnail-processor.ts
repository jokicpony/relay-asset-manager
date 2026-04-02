import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { logger } from '@/lib/logger';

/**
 * Thumbnail processor for the sync pipeline.
 *
 * Strategy:
 * - Uses Drive API's authenticated `files.get?alt=media` for small files
 *   or `thumbnailLink` with `=s800` for larger ones
 * - Processes in small batches (5 at a time) with delays to avoid throttling
 * - Uploads to Supabase Storage `thumbnails` bucket
 * - Returns a permanent, public URL for each thumbnail
 *
 * Fallback chain:
 * 1. Drive API export (for Google-native formats)
 * 2. thumbnailLink with size parameter
 * 3. Skip (asset gets no thumbnail — won't crash the UI)
 */

const THUMBNAIL_SIZE = 800;       // Max dimension in pixels
const BATCH_SIZE = 5;              // Concurrent downloads per batch
const BATCH_DELAY_MS = 500;        // Delay between batches
const SINGLE_RETRY_DELAY_MS = 1000; // Delay before retrying a failed download
const MAX_RETRIES = 2;             // Retries per thumbnail

interface ThumbnailResult {
    driveFileId: string;
    publicUrl: string | null;
    error?: string;
}

/**
 * Create a Supabase client for storage operations.
 * Uses service role key when available (server-side ingest) to bypass RLS.
 */
function getSupabaseClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

/**
 * Download a thumbnail from Google Drive using the authenticated API.
 * Falls back through multiple strategies.
 */
async function downloadThumbnail(
    accessToken: string,
    fileId: string,
    thumbnailLink: string | null,
    mimeType: string,
    retryCount = 0
): Promise<Buffer | null> {
    // Strategy 1: Use thumbnailLink with size parameter (most reliable for images/videos)
    if (thumbnailLink) {
        try {
            // Google's thumbnailLink supports size parameter: append =s800
            const sizedUrl = thumbnailLink.replace(/=s\d+$/, '') + `=s${THUMBNAIL_SIZE}`;
            const res = await fetch(sizedUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                return Buffer.from(arrayBuffer);
            }

            // If 429 (rate limited), wait and retry
            if (res.status === 429 && retryCount < MAX_RETRIES) {
                const backoff = SINGLE_RETRY_DELAY_MS * Math.pow(2, retryCount);
                logger.info('thumbnail', `Rate limited for ${fileId}, retrying in ${backoff}ms`);
                await new Promise((r) => setTimeout(r, backoff));
                return downloadThumbnail(accessToken, fileId, thumbnailLink, mimeType, retryCount + 1);
            }
        } catch (err) {
            logger.warn('thumbnail', `thumbnailLink failed for ${fileId}`, { error: String(err) });
        }
    }

    // Strategy 2: Direct file download via Drive API (for images only, not videos)
    if (mimeType.startsWith('image/')) {
        try {
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: accessToken });
            const drive = google.drive({ version: 'v3', auth });

            const res = await drive.files.get(
                { fileId, alt: 'media', supportsAllDrives: true },
                { responseType: 'arraybuffer' }
            );

            return Buffer.from(res.data as ArrayBuffer);
        } catch (err) {
            logger.warn('thumbnail', `Direct download failed for ${fileId}`, { error: String(err) });
        }
    }

    return null;
}

/**
 * Upload a thumbnail buffer to Supabase Storage.
 * Returns the public URL.
 */
async function uploadToStorage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    fileId: string,
    imageBuffer: Buffer
): Promise<string | null> {
    // Store as WebP-named file even if it's JPEG — browser handles it fine
    const filePath = `${fileId}.webp`;

    const { error } = await supabase.storage
        .from('thumbnails')
        .upload(filePath, imageBuffer, {
            contentType: 'image/webp',
            upsert: true, // Overwrite if exists (re-sync scenario)
        });

    if (error) {
        logger.error('thumbnail', `Upload failed for ${fileId}`, { error: error.message });
        return null;
    }

    // Get the public URL
    const { data } = supabase.storage
        .from('thumbnails')
        .getPublicUrl(filePath);

    return data.publicUrl;
}

/**
 * Process thumbnails for a batch of Drive files.
 * Downloads from Drive, uploads to Supabase Storage.
 *
 * @param accessToken  Google OAuth access token
 * @param files        Array of { driveFileId, thumbnailLink, mimeType }
 * @param onProgress   Optional progress callback
 * @returns Map of driveFileId → public thumbnail URL
 */
export async function processThumbnails(
    accessToken: string,
    files: Array<{
        driveFileId: string;
        thumbnailLink: string | null;
        mimeType: string;
    }>,
    onProgress?: (processed: number, total: number) => void
): Promise<Map<string, string>> {
    const supabase = getSupabaseClient();
    const urlMap = new Map<string, string>();
    let processed = 0;

    // Pre-check: find assets that already have a user-set custom thumbnail
    // in storage (custom_{driveFileId}.webp). We must never overwrite these
    // with an auto-generated thumbnail.
    const customThumbnailIds = new Set<string>();
    try {
        let listOffset = 0;
        const LIST_PAGE = 1000;
        while (true) {
            const { data: storageFiles, error: listErr } = await supabase.storage
                .from('thumbnails')
                .list('', { limit: LIST_PAGE, offset: listOffset, sortBy: { column: 'name', order: 'asc' } });

            if (listErr || !storageFiles || storageFiles.length === 0) break;

            for (const sf of storageFiles) {
                if (sf.name.startsWith('custom_')) {
                    const driveId = sf.name.replace(/^custom_/, '').replace(/\.webp$/, '');
                    if (driveId) customThumbnailIds.add(driveId);
                }
            }

            if (storageFiles.length < LIST_PAGE) break;
            listOffset += LIST_PAGE;
        }
    } catch {
        // Non-fatal — proceed without the guard
        logger.warn('thumbnail', 'Failed to scan for custom thumbnails, proceeding without guard');
    }

    // Filter out files that already have a custom thumbnail
    const filesToProcess = customThumbnailIds.size > 0
        ? files.filter(f => !customThumbnailIds.has(f.driveFileId))
        : files;

    const skippedCustom = files.length - filesToProcess.length;
    if (skippedCustom > 0) {
        logger.info('thumbnail', `Skipping ${skippedCustom} assets with custom thumbnails`);
    }

    // Process in small batches to avoid throttling
    for (let i = 0; i < filesToProcess.length; i += BATCH_SIZE) {
        const batch = filesToProcess.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(async (file): Promise<ThumbnailResult> => {
                try {
                    const buffer = await downloadThumbnail(
                        accessToken,
                        file.driveFileId,
                        file.thumbnailLink,
                        file.mimeType
                    );

                    if (!buffer) {
                        return { driveFileId: file.driveFileId, publicUrl: null, error: 'Download failed' };
                    }

                    const publicUrl = await uploadToStorage(supabase, file.driveFileId, buffer);
                    return { driveFileId: file.driveFileId, publicUrl };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    return { driveFileId: file.driveFileId, publicUrl: null, error: msg };
                }
            })
        );

        // Collect results
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.publicUrl) {
                urlMap.set(result.value.driveFileId, result.value.publicUrl);
            }
        }

        processed += batch.length;
        if (onProgress) {
            onProgress(processed, filesToProcess.length);
        }

        // Delay between batches to avoid rate limits
        if (i + BATCH_SIZE < filesToProcess.length) {
            await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    logger.info('thumbnail', `Processed ${urlMap.size}/${filesToProcess.length} thumbnails successfully${skippedCustom > 0 ? ` (${skippedCustom} custom skipped)` : ''}`);
    return urlMap;
}
