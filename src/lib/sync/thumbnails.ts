import type { SupabaseClient } from '@supabase/supabase-js';
import { encodeThumbnail, thumbnailColor, THUMBNAIL_MAX_PX } from './thumbnail-encode';
import { fetchWithDriveRetry } from './drive-retry';

/**
 * Thumbnail generation — the one pipeline behind the cron sync's thumbnail
 * step and the in-app ingest (src/lib/sync/thumbnail-processor). Each file:
 * fetch source bytes from Drive → encode to a ≤800px WebP → upload to the
 * `thumbnails` bucket as {driveFileId}.webp → compute the placeholder colour.
 *
 * No app-alias imports: scripts import this module by relative path.
 */

export interface ThumbnailSource {
    id: string;
    thumbnailLink: string | null;
    mimeType: string;
}

export interface StoredThumbnail {
    url: string;
    /** Dominant colour (#rrggbb) for the grid placeholder, when computable */
    color: string | null;
}

export interface GenerateOptions {
    /** Parallel files in flight */
    concurrency: number;
    /** Stop starting new files after this timestamp (ms); the rest are deferred */
    deadline?: number;
    /**
     * When Drive has no thumbnail yet (common right after upload), download
     * the original image instead. The in-app ingest wants this; the cron
     * leaves such files for a later run rather than pulling originals.
     */
    allowOriginal: boolean;
    /**
     * Append ?v=<timestamp> to the stored URL. Needed when an existing
     * thumbnail may be overwritten in place (re-ingest), since the image
     * optimizer caches by URL.
     */
    versioned: boolean;
    /** Retries per Drive fetch (429/5xx). Keep small inside a time budget. */
    maxRetries?: number;
    onProgress?: (done: number, total: number) => void;
}

/** Source bytes for a file's thumbnail, or null if none can be fetched. */
export async function fetchThumbnailSource(
    accessToken: string,
    file: ThumbnailSource,
    allowOriginal: boolean,
    maxRetries = 3,
): Promise<Buffer | null> {
    const auth = { headers: { Authorization: `Bearer ${accessToken}` } };

    if (file.thumbnailLink) {
        const sized = file.thumbnailLink.replace(/=s\d+$/, '') + `=s${THUMBNAIL_MAX_PX}`;
        const res = await fetchWithDriveRetry(sized, auth, maxRetries).catch(() => null);
        if (res?.ok) return Buffer.from(await res.arrayBuffer());
    }

    if (allowOriginal && file.mimeType.startsWith('image/')) {
        const res = await fetchWithDriveRetry(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
            auth,
            maxRetries,
        ).catch(() => null);
        if (res?.ok) return Buffer.from(await res.arrayBuffer());
    }

    return null;
}

/** Encode, upload and colour one thumbnail. Null if the bytes don't decode or the upload fails. */
export async function storeThumbnail(
    supabase: SupabaseClient,
    driveFileId: string,
    source: Buffer,
    versioned: boolean,
): Promise<StoredThumbnail | null> {
    const webp = await encodeThumbnail(source);
    if (!webp) return null;

    const path = `${driveFileId}.webp`;
    const { error } = await supabase.storage
        .from('thumbnails')
        .upload(path, webp, { contentType: 'image/webp', upsert: true });
    if (error) return null;

    const { data } = supabase.storage.from('thumbnails').getPublicUrl(path);
    return {
        url: versioned ? `${data.publicUrl}?v=${Date.now()}` : data.publicUrl,
        color: await thumbnailColor(webp),
    };
}

/**
 * Generate thumbnails for many files with a bounded worker pool and an
 * optional wall-clock deadline.
 */
export async function generateThumbnails(
    supabase: SupabaseClient,
    accessToken: string,
    files: ThumbnailSource[],
    opts: GenerateOptions,
): Promise<{ stored: Map<string, StoredThumbnail>; failed: number; deferred: number }> {
    const stored = new Map<string, StoredThumbnail>();
    let failed = 0;
    let deferred = 0;
    let done = 0;

    const queue = [...files];
    const worker = async () => {
        while (queue.length > 0) {
            if (opts.deadline && Date.now() > opts.deadline) {
                deferred += queue.length;
                queue.length = 0;
                return;
            }
            const file = queue.shift()!;
            try {
                const source = await fetchThumbnailSource(accessToken, file, opts.allowOriginal, opts.maxRetries);
                const result = source ? await storeThumbnail(supabase, file.id, source, opts.versioned) : null;
                if (result) stored.set(file.id, result);
                else failed++;
            } catch {
                failed++;
            }
            opts.onProgress?.(++done, files.length);
        }
    };
    await Promise.all(Array.from({ length: Math.min(opts.concurrency, files.length) }, worker));

    return { stored, failed, deferred };
}
