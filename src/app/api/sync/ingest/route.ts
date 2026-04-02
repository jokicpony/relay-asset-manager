/**
 * Targeted Ingest API — Directly ingest specific files into the DAM.
 *
 * POST /api/sync/ingest
 * Body: { fileIds: string[], destFolderId: string }
 *
 * This is NOT a Drive sync. It fetches metadata for specific files via
 * drive.files.get, re-validates they're still in a DAM-scoped folder,
 * then upserts them into the assets table with full treatment:
 * thumbnails, rights labels, parsed metadata — everything.
 *
 * Used by the namer's deferred ingest pipeline after batch completion.
 */

import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getDriveAccessToken } from '@/lib/google/auth';
import { upsertAssets } from '@/lib/sync/upsert';
import { processThumbnails } from '@/lib/sync/thumbnail-processor';
import { parseFilename } from '@/lib/filename-utils';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { createClient } from '@supabase/supabase-js';
import type { DriveFile } from '@/lib/sync/drive-crawler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // 2 min max — targeted ingest is fast

// ---------------------------------------------------------------------------
// Rights Label parsing — reads field IDs and choice mappings from app_settings
// via getConfig().rightsLabelConfig. See Settings → Rights Label Config.
import type { RightsLabelConfig } from '@/lib/config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseLabelFields(file: any, labelId: string, rightsConfig: RightsLabelConfig) {
    const result = {
        organicRights: null as string | null,
        organicRightsExpiration: null as string | null,
        paidRights: null as string | null,
        paidRightsExpiration: null as string | null,
    };

    // Skip if rights label config is not set up
    const { fieldIds, choiceMap } = rightsConfig;
    if (!fieldIds.organicRights && !fieldIds.paidRights) return result;

    if (!file.labelInfo?.labels) return result;

    for (const label of file.labelInfo.labels) {
        if (label.id !== labelId) continue;
        if (!label.fields) continue;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fields = label.fields as Record<string, any>;

        if (fieldIds.organicRights && fields[fieldIds.organicRights]?.selection) {
            const choiceId = fields[fieldIds.organicRights].selection[0];
            result.organicRights = choiceMap[choiceId] ?? choiceId;
        }
        if (fieldIds.organicExpiration && fields[fieldIds.organicExpiration]?.dateString) {
            result.organicRightsExpiration = fields[fieldIds.organicExpiration].dateString[0] ?? null;
        }
        if (fieldIds.paidRights && fields[fieldIds.paidRights]?.selection) {
            const choiceId = fields[fieldIds.paidRights].selection[0];
            result.paidRights = choiceMap[choiceId] ?? choiceId;
        }
        if (fieldIds.paidExpiration && fields[fieldIds.paidExpiration]?.dateString) {
            result.paidRightsExpiration = fields[fieldIds.paidExpiration].dateString[0] ?? null;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// MIME type sets — must match drive-crawler.ts
// ---------------------------------------------------------------------------
const IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'image/tiff', 'image/heic', 'image/heif',
]);
const VIDEO_MIMES = new Set([
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/webm', 'video/mpeg',
]);

// ---------------------------------------------------------------------------
// Folder path resolution
// ---------------------------------------------------------------------------
const pathCache = new Map<string, string>();

async function resolveFolderPath(
    drive: ReturnType<typeof google.drive>,
    parentId: string,
    driveId: string,
): Promise<string> {
    if (parentId === driveId) return '/';
    if (pathCache.has(parentId)) return pathCache.get(parentId)!;

    try {
        const res = await drive.files.get({
            fileId: parentId,
            fields: 'id,name,parents',
            supportsAllDrives: true,
        });

        const parentPath = res.data.parents?.[0]
            ? await resolveFolderPath(drive, res.data.parents[0], driveId)
            : '/';

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
 * Check if a folder path is within the syncFolders scope.
 */
function isInSyncScope(folderPath: string, syncFolders: string[]): boolean {
    if (syncFolders.length === 0) return true; // No filter = everything is in scope
    const topFolder = folderPath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
    return syncFolders.some(f => topFolder === f.toLowerCase());
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
    try {
        const { fileIds, destFolderId } = await request.json();

        if (!Array.isArray(fileIds) || fileIds.length === 0 || !destFolderId) {
            return NextResponse.json(
                { error: 'fileIds (array) and destFolderId are required' },
                { status: 400 }
            );
        }

        logger.info('ingest', `Starting targeted ingest for ${fileIds.length} files`, { destFolderId });

        // Get config and access token
        const config = await getConfig();
        const accessToken = await getDriveAccessToken();
        const driveId = config.sharedDriveId;

        if (!driveId) {
            return NextResponse.json({ error: 'Shared Drive ID not configured' }, { status: 500 });
        }

        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: accessToken });
        const drive = google.drive({ version: 'v3', auth });

        const syncFolders = config.syncFolders.map(f => f.toLowerCase());
        const labelId = config.driveLabelId;

        // Fields to request — full metadata including labels and dimensions
        const fileFields = [
            'id', 'name', 'mimeType', 'size', 'description', 'parents',
            'thumbnailLink', 'createdTime', 'modifiedTime',
            'imageMediaMetadata(width,height)',
            'videoMediaMetadata(width,height,durationMillis)',
            'labelInfo',
        ].join(',');

        const driveFiles: DriveFile[] = [];
        const skipped: { fileId: string; reason: string }[] = [];
        const errors: string[] = [];

        // Fetch metadata for each file and re-validate location
        for (const fileId of fileIds) {
            try {
                const res = await drive.files.get({
                    fileId,
                    fields: fileFields,
                    supportsAllDrives: true,
                    includeLabels: labelId || undefined,
                });

                const file = res.data;
                if (!file.id || !file.name || !file.mimeType) {
                    skipped.push({ fileId, reason: 'Missing required metadata' });
                    continue;
                }

                // Check it's a supported asset type
                const isImage = IMAGE_MIMES.has(file.mimeType);
                const isVideo = VIDEO_MIMES.has(file.mimeType);
                if (!isImage && !isVideo) {
                    skipped.push({ fileId, reason: `Unsupported mime type: ${file.mimeType}` });
                    continue;
                }

                // ── RE-VALIDATION: Check current folder location ──
                // The file may have been moved since the namer processed it.
                // Only ingest if it's still in a DAM-scoped folder.
                const parentId = file.parents?.[0];
                if (!parentId) {
                    skipped.push({ fileId, reason: 'No parent folder' });
                    continue;
                }

                const folderPath = await resolveFolderPath(drive, parentId, driveId);

                if (!isInSyncScope(folderPath, syncFolders)) {
                    skipped.push({ fileId, reason: `Not in sync scope: ${folderPath}` });
                    logger.info('ingest', `Skipped ${file.name} — not in sync scope`, { folderPath });
                    continue;
                }

                // Parse rights labels
                const rights = labelId ? parseLabelFields(file, labelId, config.rightsLabelConfig) : {
                    organicRights: null,
                    organicRightsExpiration: null,
                    paidRights: null,
                    paidRightsExpiration: null,
                };

                // Extract dimensions
                const width = isImage
                    ? file.imageMediaMetadata?.width ?? 0
                    : file.videoMediaMetadata?.width ?? 0;
                const height = isImage
                    ? file.imageMediaMetadata?.height ?? 0
                    : file.videoMediaMetadata?.height ?? 0;
                const duration = isVideo && file.videoMediaMetadata?.durationMillis
                    ? Number(file.videoMediaMetadata.durationMillis) / 1000
                    : null;

                // Parse filename for structured metadata
                const parsed = parseFilename(file.name);

                driveFiles.push({
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
                    organicRights: rights.organicRights,
                    organicRightsExpiration: rights.organicRightsExpiration,
                    paidRights: rights.paidRights,
                    paidRightsExpiration: rights.paidRightsExpiration,
                    creator: null,
                    projectDescription: null,
                    parsedCreator: parsed.creator,
                    parsedShootDate: parsed.shootDate?.toISOString().split('T')[0] ?? null,
                    parsedShootDescription: parsed.shootDescription,
                    fileSize: (file as any).size ? Number((file as any).size) : null,
                });

                // Small delay between file lookups to avoid rate limits
                await new Promise(r => setTimeout(r, 100));
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`${fileId}: ${msg}`);
                logger.error('ingest', `Failed to fetch file ${fileId}`, { error: msg });
            }
        }

        if (driveFiles.length === 0) {
            logger.info('ingest', 'No files to ingest after re-validation', { skipped: skipped.length });
            return NextResponse.json({
                ingested: 0,
                thumbnails: 0,
                skipped,
                errors,
            });
        }

        // ── Upsert assets into the database ──
        logger.info('ingest', `Upserting ${driveFiles.length} assets`);
        const { upserted, errors: upsertErrors } = await upsertAssets(
            driveFiles,
            undefined,
            { preserveExistingThumbnails: true }
        );

        if (upsertErrors.length > 0) {
            errors.push(...upsertErrors);
        }

        // ── Process thumbnails ──
        logger.info('ingest', `Processing thumbnails for ${driveFiles.length} assets`);
        const thumbFiles = driveFiles.map(f => ({
            driveFileId: f.id,
            thumbnailLink: f.thumbnailLink,
            mimeType: f.mimeType,
        }));

        const urlMap = await processThumbnails(accessToken, thumbFiles);

        // Update thumbnail URLs in the database
        const adminClient = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        );

        let thumbnailsUpdated = 0;
        for (const [driveFileId, publicUrl] of urlMap) {
            const { error } = await adminClient
                .from('assets')
                .update({ thumbnail_url: publicUrl })
                .eq('drive_file_id', driveFileId);
            if (!error) thumbnailsUpdated++;
        }

        // ── Update folder_drive_ids mapping ──
        // Persist any new folder paths discovered during ingest
        if (pathCache.size > 0) {
            const folderIdMap: Record<string, string> = {};
            for (const [driveId, path] of pathCache.entries()) {
                folderIdMap[path] = driveId;
            }

            // Merge with existing mapping
            const { data: existing } = await adminClient
                .from('app_settings')
                .select('value')
                .eq('key', 'folder_drive_ids')
                .single();

            const merged = { ...(existing?.value as Record<string, string> || {}), ...folderIdMap };
            await adminClient.from('app_settings').upsert({
                key: 'folder_drive_ids',
                value: merged,
                updated_at: new Date().toISOString(),
            });
        }

        // Clear path cache for next request
        pathCache.clear();

        logger.info('ingest', `Ingest complete: ${upserted} upserted, ${thumbnailsUpdated} thumbnails`, {
            skipped: skipped.length,
            errors: errors.length,
        });

        return NextResponse.json({
            ingested: upserted,
            thumbnails: thumbnailsUpdated,
            skipped,
            errors,
        });

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        logger.error('ingest', 'Targeted ingest failed', { error: message });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
