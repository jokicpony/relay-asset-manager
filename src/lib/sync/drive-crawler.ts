import { google, type drive_v3 } from 'googleapis';
import { parseFilename } from '@/lib/filename-utils';

/**
 * File metadata as returned by the Drive crawler.
 */
export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    description: string | null;
    folderPath: string;
    thumbnailLink: string | null;
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

// Supported image/video MIME types
const IMAGE_MIMES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/tiff',
    'image/heic',
    'image/heif',
]);

const VIDEO_MIMES = new Set([
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
    'video/webm',
    'video/mpeg',
]);

/**
 * Simple throttle to avoid hitting Drive API rate limits.
 * Google allows 12,000 queries/min — this keeps us well under.
 */
const throttle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a Google Drive client from an OAuth access token.
 */
function createDriveClient(accessToken: string): drive_v3.Drive {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.drive({ version: 'v3', auth });
}

/**
 * Build folder path by resolving Drive parent chain.
 * Uses a cache to avoid redundant API calls.
 */
async function resolveFolderPath(
    drive: drive_v3.Drive,
    fileParents: string[] | null | undefined,
    driveId: string,
    pathCache: Map<string, string>,
    ignoredFolderIds: Set<string>
): Promise<string> {
    if (!fileParents || fileParents.length === 0) return '/';

    const parentId = fileParents[0];

    // Root of the shared drive
    if (parentId === driveId) return '/';

    // Check cache
    if (pathCache.has(parentId)) return pathCache.get(parentId)!;

    // Resolve parent chain
    try {
        await throttle(50); // Rate limit folder lookups
        const res = await drive.files.get({
            fileId: parentId,
            fields: 'id,name,parents,description',
            supportsAllDrives: true,
        });

        // Check for [relay-ignore] tag in folder description
        if (res.data.description && res.data.description.includes('[relay-ignore]')) {
            ignoredFolderIds.add(parentId);
        }

        const parentPath = await resolveFolderPath(
            drive,
            res.data.parents,
            driveId,
            pathCache,
            ignoredFolderIds
        );

        // If any ancestor is ignored, this folder is also ignored
        if (res.data.parents?.some(p => ignoredFolderIds.has(p))) {
            ignoredFolderIds.add(parentId);
        }

        const fullPath = parentPath === '/'
            ? `/${res.data.name}`
            : `${parentPath}/${res.data.name}`;

        pathCache.set(parentId, fullPath);
        return fullPath;
    } catch {
        return '/unknown';
    }
}

/**
 * Crawl a Google Shared Drive for all photo/video files.
 * Returns an array of structured DriveFile objects.
 *
 * @param accessToken    OAuth access token from the authenticated user
 * @param driveId        Shared Drive ID
 * @param sinceDate      Optional: only return files modified after this date (ISO string)
 * @param onProgress     Optional: progress callback (filesProcessed, totalEstimate)
 * @param syncFolderList Optional: folder allowlist (overrides SYNC_FOLDERS env var)
 */
export async function crawlDrive(
    accessToken: string,
    driveId: string,
    sinceDate?: string,
    onProgress?: (processed: number, total: number) => void,
    syncFolderList?: string[]
): Promise<{ files: DriveFile[]; folderIdMap: Record<string, string> }> {
    const drive = createDriveClient(accessToken);
    const pathCache = new Map<string, string>();
    const ignoredFolderIds = new Set<string>();
    const results: DriveFile[] = [];

    // Load folder allowlist: prefer param, fall back to env var
    const syncFolders = syncFolderList
        ? syncFolderList.map((f) => f.trim().toLowerCase()).filter(Boolean)
        : (process.env.SYNC_FOLDERS ?? '')
            .split(',')
            .map((f) => f.trim().toLowerCase())
            .filter(Boolean);

    // Build the query
    const mimeFilter = [
        ...Array.from(IMAGE_MIMES),
        ...Array.from(VIDEO_MIMES),
    ]
        .map((m) => `mimeType='${m}'`)
        .join(' or ');

    let query = `(${mimeFilter}) and trashed=false`;
    if (sinceDate) {
        query += ` and modifiedTime > '${sinceDate}'`;
    }

    const fields = 'nextPageToken,files(id,name,mimeType,size,description,parents,thumbnailLink,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis),createdTime,modifiedTime)';

    let pageToken: string | undefined;
    let totalProcessed = 0;

    do {
        const res = await drive.files.list({
            q: query,
            driveId: driveId,
            corpora: 'drive',
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: fields,
            pageSize: 100,
            pageToken: pageToken,
        });

        const files = res.data.files || [];

        for (const file of files) {
            if (!file.id || !file.name || !file.mimeType) continue;

            const isVideo = VIDEO_MIMES.has(file.mimeType);
            const isImage = IMAGE_MIMES.has(file.mimeType);
            if (!isVideo && !isImage) continue;

            // Resolve folder path
            const folderPath = await resolveFolderPath(
                drive,
                file.parents,
                driveId,
                pathCache,
                ignoredFolderIds
            );

            // [relay-ignore] check — skip files in ignored folders
            if (file.parents?.some(p => ignoredFolderIds.has(p))) {
                continue;
            }

            // Allowlist check: if SYNC_FOLDERS is set, only include files
            // whose top-level folder matches one of the allowed folders
            if (syncFolders.length > 0) {
                const topLevelFolder = folderPath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
                const isAllowed = syncFolders.some((f) => topLevelFolder === f);
                if (!isAllowed) continue;
            }

            // Parse filename for metadata
            const parsed = parseFilename(file.name);

            // Extract dimensions
            const width = isImage
                ? file.imageMediaMetadata?.width ?? 0
                : file.videoMediaMetadata?.width ?? 0;
            const height = isImage
                ? file.imageMediaMetadata?.height ?? 0
                : file.videoMediaMetadata?.height ?? 0;

            // Video duration (milliseconds → seconds)
            const duration = isVideo && file.videoMediaMetadata?.durationMillis
                ? Number(file.videoMediaMetadata.durationMillis) / 1000
                : null;

            results.push({
                id: file.id,
                name: file.name,
                mimeType: file.mimeType,
                description: file.description ?? null,
                folderPath,
                thumbnailLink: file.thumbnailLink ?? null,
                width,
                height,
                duration,
                assetType: isVideo ? 'video' : 'photo',
                createdTime: file.createdTime ?? file.modifiedTime ?? new Date().toISOString(),
                modifiedTime: file.modifiedTime ?? new Date().toISOString(),
                // Drive Labels — will be populated in a future enhancement
                // when Drive Labels API integration is added
                organicRights: null,
                organicRightsExpiration: null,
                paidRights: null,
                paidRightsExpiration: null,
                creator: null,
                projectDescription: null,
                // Parsed from filename
                parsedCreator: parsed.creator,
                parsedShootDate: parsed.shootDate?.toISOString().split('T')[0] ?? null,
                parsedShootDescription: parsed.shootDescription,
                fileSize: (file as any).size ? Number((file as any).size) : null,
            });

            totalProcessed++;
            if (onProgress) {
                onProgress(totalProcessed, totalProcessed); // We don't know total upfront
            }
        }

        pageToken = res.data.nextPageToken ?? undefined;

        // Throttle between pages to avoid rate limits
        if (pageToken) await throttle(200);
    } while (pageToken);

    // Build inverted map: folder path → Drive folder ID
    const folderIdMap: Record<string, string> = {};
    for (const [driveId, path] of pathCache.entries()) {
        folderIdMap[path] = driveId;
    }

    return { files: results, folderIdMap };
}

/**
 * Fetch the list of file IDs currently in the Shared Drive (for deletion detection).
 */
export async function listActiveDriveFileIds(
    accessToken: string,
    driveId: string
): Promise<Set<string>> {
    const drive = createDriveClient(accessToken);
    const ids = new Set<string>();

    const mimeFilter = [
        ...Array.from(IMAGE_MIMES),
        ...Array.from(VIDEO_MIMES),
    ]
        .map((m) => `mimeType='${m}'`)
        .join(' or ');

    let pageToken: string | undefined;

    do {
        const res = await drive.files.list({
            q: `(${mimeFilter}) and trashed=false`,
            driveId: driveId,
            corpora: 'drive',
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
            fields: 'nextPageToken,files(id)',
            pageSize: 1000,
            pageToken: pageToken,
        });

        for (const file of res.data.files || []) {
            if (file.id) ids.add(file.id);
        }

        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return ids;
}
