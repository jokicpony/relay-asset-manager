/**
 * Shared row shape for the targeted-ingest path.
 *
 * Used by the namer's per-file ingest (src/app/api/sync/ingest) and the
 * upsert helpers. The full Shared-Drive crawler lives in scripts/sync.ts;
 * this module only carries the metadata shape for individually-selected files.
 */
export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    description: string | null;
    folderPath: string;
    thumbnailLink: string | null;
    webViewLink: string | null;
    width: number;
    height: number;
    duration: number | null;
    assetType: 'photo' | 'video';
    createdTime: string;
    modifiedTime: string;
    // Drive Label fields (nullable — depends on label configuration)
    organicRights: string | null;
    organicRightsExpiration: string | null;
    paidRights: string | null;
    paidRightsExpiration: string | null;
    creator: string | null;
    projectDescription: string | null;
    // Parsed from filename
    parsedCreator: string | null;
    parsedShootDate: string | null;        // ISO date string
    parsedShootDescription: string | null;
    fileSize: number | null;
}
