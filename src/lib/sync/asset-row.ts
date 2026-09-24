import type { DriveFile } from './types';

/**
 * Build the assets-table row for a Drive file — the single column mapping
 * used by both upsert paths (scripts/sync.ts and src/lib/sync/upsert.ts).
 * Divergence here is what caused namer-ingested assets to miss preview_url.
 *
 * Never writes thumbnail_url: Drive thumbnailLinks are temporary
 * googleusercontent URLs. Callers set the permanent Supabase Storage URL
 * themselves (the crawler inline from its thumbnail pass, the ingest route
 * after processThumbnails).
 *
 * No app-alias imports here: scripts import this module by relative path
 * under tsx, same as src/lib/filename-utils.
 */
export function buildAssetRow(
    file: DriveFile,
    opts: { labelsFetched?: boolean } = {},
): Record<string, unknown> {
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
        // A file present in Drive is live by definition. Clearing the trash
        // fields here matters because the upsert runs before orphan
        // detection: a trashed row that reappears (re-scoped folder, removed
        // [relay-ignore]) is reactivated right here, and a stale deleted_at
        // would both hide it from the restore pass and block any future
        // soft-delete, leaving a dead asset in the library forever.
        is_active: true,
        deleted_at: null,
        deleted_reason: null,
        drive_created_at: file.createdTime,
        drive_modified_at: file.modifiedTime,
        file_size: file.fileSize ?? null,
        updated_at: new Date().toISOString(),
    };

    // Omit when absent so an upsert preserves an existing value.
    if (file.webViewLink) {
        row.preview_url = file.webViewLink;
    }

    // Rights columns: when the caller fetched Drive Labels (both sync paths
    // do whenever a rights label is configured), write them even when null —
    // that's how a label removed in Drive gets cleared here. Without label
    // data, omit them so the upsert preserves the stored values.
    const hasRightsData = file.organicRights !== null || file.paidRights !== null
        || file.organicRightsExpiration !== null || file.paidRightsExpiration !== null;
    if (opts.labelsFetched || hasRightsData) {
        row.organic_rights = file.organicRights;
        row.organic_rights_expiration = file.organicRightsExpiration;
        row.paid_rights = file.paidRights;
        row.paid_rights_expiration = file.paidRightsExpiration;
    }

    // creator / project_description are user- or namer-managed columns; only
    // write them when the caller supplies a value, never null them out.
    if (file.creator !== null) row.creator = file.creator;
    if (file.projectDescription !== null) row.project_description = file.projectDescription;

    return row;
}

/**
 * Split upsert rows into groups that share the exact same set of columns.
 *
 * postgrest-js sends a bulk upsert with `columns` = the union of every row's
 * keys, and fills a key a row lacks with NULL — so "omit the column to
 * preserve it" silently NULLs that column whenever any other row in the same
 * batch includes it. (This had been wiping custom video-frame thumbnail URLs
 * on every other sync.) Upserting each group separately makes omission mean
 * what the row-building code intends. Rows almost always share one shape,
 * so this rarely adds a request.
 */
export function groupRowsByColumns(rows: Record<string, unknown>[]): Record<string, unknown>[][] {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
        const signature = Object.keys(row).sort().join(',');
        let group = groups.get(signature);
        if (!group) groups.set(signature, (group = []));
        group.push(row);
    }
    return [...groups.values()];
}
