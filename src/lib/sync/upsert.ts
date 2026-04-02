import { createClient } from '@supabase/supabase-js';
import type { DriveFile } from './drive-crawler';

/**
 * Create a Supabase admin client (bypasses RLS) for server-side sync operations.
 * Uses the service role key for write access, falling back to anon key.
 */
function createAdminClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
}

/**
 * Upsert a batch of Drive files into the assets table.
 * Uses drive_file_id as the conflict key for idempotent upserts.
 *
 * @returns Number of rows upserted
 */
export async function upsertAssets(
    files: DriveFile[],
    supabaseAccessToken?: string,
    options?: { preserveExistingThumbnails?: boolean }
): Promise<{ upserted: number; errors: string[] }> {
    const supabase = createAdminClient();
    const preserveThumbnails = options?.preserveExistingThumbnails ?? false;

    // If we have a user's Supabase access token, set it for RLS
    if (supabaseAccessToken) {
        supabase.realtime.setAuth(supabaseAccessToken);
    }

    // When preserving thumbnails, look up which assets already have one
    // so we only set thumbnail_url for genuinely new assets
    const existingThumbnailIds = new Set<string>();
    if (preserveThumbnails) {
        const driveIds = files.map((f) => f.id);
        // Query in batches of 500 to avoid URL length limits
        for (let i = 0; i < driveIds.length; i += 500) {
            const batch = driveIds.slice(i, i + 500);
            const { data } = await supabase
                .from('assets')
                .select('drive_file_id')
                .in('drive_file_id', batch)
                .not('thumbnail_url', 'is', null)
                .not('thumbnail_url', 'like', '%googleusercontent.com%');
            if (data) {
                for (const row of data) {
                    existingThumbnailIds.add(row.drive_file_id);
                }
            }
        }
    }

    const errors: string[] = [];
    let upserted = 0;

    // Process in batches of 200 for fewer round trips
    const BATCH_SIZE = 200;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);

        const rows = batch.map((file) => {
            const row: Record<string, unknown> = {
                drive_file_id: file.id,
                name: file.name,
                description: file.description,
                mime_type: file.mimeType,
                asset_type: file.assetType,
                folder_path: file.folderPath,
                width: file.width,
                height: file.height,
                duration: file.duration,
                parsed_creator: file.parsedCreator,
                parsed_shoot_date: file.parsedShootDate,
                parsed_shoot_description: file.parsedShootDescription,
                is_active: true,
                drive_created_at: file.createdTime,
                drive_modified_at: file.modifiedTime,
                file_size: file.fileSize ?? null,
                updated_at: new Date().toISOString(),
            };
            // Only write rights columns if the crawler actually fetched labels.
            // The manual sync (drive-crawler.ts) doesn't request Drive Labels,
            // so all rights fields are null. Omitting them from the upsert
            // preserves the existing values set by the overnight sync.
            const hasRightsData = file.organicRights !== null || file.paidRights !== null
                || file.organicRightsExpiration !== null || file.paidRightsExpiration !== null;
            if (hasRightsData) {
                row.organic_rights = file.organicRights;
                row.organic_rights_expiration = file.organicRightsExpiration;
                row.paid_rights = file.paidRights;
                row.paid_rights_expiration = file.paidRightsExpiration;
                row.creator = file.creator;
                row.project_description = file.projectDescription;
            }
            // Include thumbnail for new assets; preserve existing permanent URLs.
            // Never write temporary Google thumbnailLink URLs — they expire and
            // are low-resolution. Only write actual Supabase Storage URLs.
            if (!preserveThumbnails || !existingThumbnailIds.has(file.id)) {
                const isGoogleTempUrl = file.thumbnailLink?.includes('googleusercontent.com');
                if (file.thumbnailLink && !isGoogleTempUrl) {
                    row.thumbnail_url = file.thumbnailLink;
                }
            }
            return row;
        });

        const { error, count } = await supabase
            .from('assets')
            .upsert(rows, {
                onConflict: 'drive_file_id',
                ignoreDuplicates: false,
            });

        if (error) {
            errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message}`);
        } else {
            upserted += count ?? batch.length;
        }
    }

    return { upserted, errors };
}

/**
 * Mark assets as inactive if their Drive file IDs are no longer in the active set.
 *
 * @param activeDriveIds  Set of file IDs currently in Drive
 * @returns Number of assets marked inactive
 */
export async function markDeletedAssets(
    activeDriveIds: Set<string>
): Promise<{ deactivated: number; error: string | null }> {
    const supabase = createAdminClient();

    // Get all currently active assets from our database (paginated — default limit is 1000)
    const dbAssets: { id: string; drive_file_id: string }[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const { data, error } = await supabase
            .from('assets')
            .select('id, drive_file_id')
            .eq('is_active', true)
            .range(from, from + PAGE - 1);

        if (error) {
            return { deactivated: 0, error: error.message };
        }
        if (!data || data.length === 0) break;
        dbAssets.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }

    // Find assets in our DB that are no longer in Drive
    const toDeactivate = dbAssets
        .filter((asset) => !activeDriveIds.has(asset.drive_file_id))
        .map((asset) => asset.id);

    if (toDeactivate.length === 0) {
        return { deactivated: 0, error: null };
    }

    // Mark them inactive in batches (with proper soft-delete tracking)
    const BATCH_SIZE = 100;
    let deactivated = 0;

    for (let i = 0; i < toDeactivate.length; i += BATCH_SIZE) {
        const batch = toDeactivate.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
            .from('assets')
            .update({
                is_active: false,
                deleted_at: new Date().toISOString(),
                deleted_reason: 'orphaned',
                updated_at: new Date().toISOString(),
            })
            .in('id', batch)
            .is('deleted_at', null); // Don't reset countdown if already soft-deleted

        if (error) {
            return { deactivated, error: error.message };
        }
        deactivated += batch.length;
    }

    return { deactivated, error: null };
}

/**
 * Get the timestamp of the most recently updated asset.
 * Used to determine the `sinceDate` for incremental syncs.
 */
export async function getLastSyncTimestamp(): Promise<string | null> {
    const supabase = createAdminClient();

    const { data, error } = await supabase
        .from('assets')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !data) return null;
    return data.updated_at;
}
