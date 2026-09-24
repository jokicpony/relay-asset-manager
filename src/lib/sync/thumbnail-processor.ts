import { logger } from '@/lib/logger';
import { getAdminClient } from '@/lib/supabase/admin';
import { generateThumbnails, type StoredThumbnail } from './thumbnails';

export type { StoredThumbnail };

/**
 * Thumbnails for the in-app ingest (after a Namer batch). Thin wrapper over
 * the shared pipeline in ./thumbnails, differing from the cron sync only in
 * policy:
 * - regenerates even if a thumbnail exists (re-ingest after a rename/move),
 *   with versioned URLs so the image optimizer doesn't serve the old one;
 * - falls back to the original image when Drive hasn't generated a
 *   thumbnail yet (common right after upload);
 * - never overwrites a user-set custom video frame.
 *
 * @returns Map of driveFileId → stored thumbnail (public URL + placeholder colour)
 */
export async function processThumbnails(
    accessToken: string,
    files: Array<{
        driveFileId: string;
        thumbnailLink: string | null;
        mimeType: string;
    }>,
    /** Stop starting new thumbnails after this time (ms) — see the ingest route */
    deadline?: number,
): Promise<Map<string, StoredThumbnail>> {
    const supabase = getAdminClient();

    // Assets with a user-set custom frame (custom_{id}.webp) keep it.
    const customThumbnailIds = new Set<string>();
    const ids = files.map(f => f.driveFileId);
    for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase
            .from('assets')
            .select('drive_file_id')
            .in('drive_file_id', ids.slice(i, i + 150))
            .like('thumbnail_url', '%/custom_%');
        if (error) {
            logger.warn('thumbnail', 'Custom-thumbnail lookup failed, proceeding without guard', { error: error.message });
            break;
        }
        for (const row of data ?? []) customThumbnailIds.add(row.drive_file_id);
    }

    const toProcess = files
        .filter(f => !customThumbnailIds.has(f.driveFileId))
        .map(f => ({ id: f.driveFileId, thumbnailLink: f.thumbnailLink, mimeType: f.mimeType }));
    if (customThumbnailIds.size > 0) {
        logger.info('thumbnail', `Skipping ${customThumbnailIds.size} assets with custom thumbnails`);
    }

    const { stored, failed, deferred } = await generateThumbnails(supabase, accessToken, toProcess, {
        concurrency: 5,
        allowOriginal: true,
        versioned: true,
        maxRetries: 2, // inside a 120s route: fail fast, the cron retries later
        deadline,
    });

    logger.info('thumbnail', `Processed ${stored.size}/${toProcess.length} thumbnails`
        + `${failed > 0 ? ` (${failed} failed)` : ''}${deferred > 0 ? ` (${deferred} deferred to the next sync)` : ''}`);
    return stored;
}
