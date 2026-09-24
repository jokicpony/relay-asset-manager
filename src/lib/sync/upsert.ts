import type { DriveFile } from './types';
import { buildAssetRow, groupRowsByColumns } from './asset-row';
import { getAdminClient } from '@/lib/supabase/admin';

/**
 * Upsert a batch of Drive files into the assets table.
 * Uses drive_file_id as the conflict key for idempotent upserts.
 * Column mapping lives in buildAssetRow (shared with scripts/sync.ts).
 *
 * @returns Number of rows upserted
 */
export async function upsertAssets(
    files: DriveFile[],
    opts: { labelsFetched?: boolean } = {},
): Promise<{ upserted: number; errors: string[] }> {
    const supabase = getAdminClient();

    const errors: string[] = [];
    let upserted = 0;

    // Process in batches of 200 for fewer round trips
    const BATCH_SIZE = 200;

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const rows = batch.map((f) => buildAssetRow(f, opts));

        // Same-shape groups: an omitted column must be preserved, not NULLed
        for (const group of groupRowsByColumns(rows)) {
            const { error } = await supabase
                .from('assets')
                .upsert(group, {
                    onConflict: 'drive_file_id',
                    ignoreDuplicates: false,
                });

            if (error) {
                errors.push(`Batch ${i / BATCH_SIZE + 1}: ${error.message}`);
            } else {
                upserted += group.length;
            }
        }
    }

    return { upserted, errors };
}

/**
 * Get the timestamp of the most recently updated asset.
 * Used to determine the `sinceDate` for incremental syncs.
 */
export async function getLastSyncTimestamp(): Promise<string | null> {
    const supabase = getAdminClient();

    const { data, error } = await supabase
        .from('assets')
        .select('updated_at')
        .order('updated_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !data) return null;
    return data.updated_at;
}
