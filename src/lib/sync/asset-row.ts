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
export function buildAssetRow(file: DriveFile): Record<string, unknown> {
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

    // Only write rights columns if the caller actually fetched label data.
    // When labels weren't requested/available these are null — omit them so
    // the upsert preserves values set by the other sync path.
    const hasRightsData = file.organicRights !== null || file.paidRights !== null
        || file.organicRightsExpiration !== null || file.paidRightsExpiration !== null;
    if (hasRightsData) {
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
