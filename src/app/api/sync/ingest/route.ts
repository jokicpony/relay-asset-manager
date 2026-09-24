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
import { IMAGE_MIMES, VIDEO_MIMES } from '@/lib/sync/mime';
import { parseLabelFields, emptyRightsFields } from '@/lib/sync/rights-labels';
import { parseFilename } from '@/lib/filename-utils';
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import type { DriveFile } from '@/lib/sync/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // 2 min max — targeted ingest is fast

// ---------------------------------------------------------------------------
// Folder path resolution
//
// pathCache is request-scoped (passed in by the handler) — never module-level.
// A shared module cache would be corrupted by concurrent ingests, and the
// end-of-request clear() would wipe another in-flight request's entries.
//
// Alongside the path, each folder carries an `ignored` flag: [relay-ignore]
// in a folder's Drive description excludes it and all descendants, matching
// the crawler in scripts/sync.ts. Without this check here, ingested assets
// bounce — inserted now, soft-deleted as 'ignored' by the next cron sync.
// ---------------------------------------------------------------------------
interface FolderInfo {
    path: string;
    ignored: boolean;
}

async function resolveFolderPath(
    drive: ReturnType<typeof google.drive>,
    parentId: string,
    driveId: string,
    pathCache: Map<string, FolderInfo>,
): Promise<FolderInfo> {
    if (parentId === driveId) return { path: '/', ignored: false };
    if (pathCache.has(parentId)) return pathCache.get(parentId)!;

    try {
        const res = await drive.files.get({
            fileId: parentId,
            fields: 'id,name,parents,description',
            supportsAllDrives: true,
        });

        const parent = res.data.parents?.[0]
            ? await resolveFolderPath(drive, res.data.parents[0], driveId, pathCache)
            : { path: '/', ignored: false };

        const fullPath = parent.path === '/'
            ? `/${res.data.name}`
            : `${parent.path}/${res.data.name}`;

        const info: FolderInfo = {
            path: fullPath,
            ignored: parent.ignored || Boolean(res.data.description?.includes('[relay-ignore]')),
        };
        pathCache.set(parentId, info);
        return info;
    } catch {
        return { path: '/unknown', ignored: false };
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
    // Auth check — the middleware also gates /api, but keep the in-route check
    // consistent with every other route (defense in depth).
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

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

        // Request-scoped folder path cache (see resolveFolderPath note above).
        const pathCache = new Map<string, FolderInfo>();

        const syncFolders = config.syncFolders.map(f => f.toLowerCase());
        const labelId = config.driveLabelId;

        // Fields to request — full metadata including labels and dimensions
        const fileFields = [
            'id', 'name', 'mimeType', 'size', 'description', 'parents',
            'thumbnailLink', 'webViewLink', 'createdTime', 'modifiedTime',
            'imageMediaMetadata(width,height)',
            'videoMediaMetadata(width,height,durationMillis)',
            'labelInfo',
        ].join(',');

        const driveFiles: DriveFile[] = [];
        const skipped: { fileId: string; reason: string }[] = [];
        const errors: string[] = [];

        // Fetch metadata in small parallel chunks — one-at-a-time lookups
        // with a 100ms pause each risked blowing the route's 120s budget on
        // large namer batches, timing out after the upsert but mid-thumbnails.
        const FETCH_CHUNK = 5;
        for (let chunkStart = 0; chunkStart < fileIds.length; chunkStart += FETCH_CHUNK) {
            const chunk = fileIds.slice(chunkStart, chunkStart + FETCH_CHUNK);
            const fetched = await Promise.all(chunk.map(async (fileId: string) => {
                try {
                    const res = await drive.files.get({
                        fileId,
                        fields: fileFields,
                        supportsAllDrives: true,
                        includeLabels: labelId || undefined,
                    });
                    return { fileId, file: res.data };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${fileId}: ${msg}`);
                    logger.error('ingest', `Failed to fetch file ${fileId}`, { error: msg });
                    return null;
                }
            }));

            // Validate sequentially — folder resolution reuses the warm pathCache
            for (const item of fetched) {
                if (!item) continue;
                const { fileId, file } = item;

                if (!file.id || !file.name || !file.mimeType) {
                    skipped.push({ fileId, reason: 'Missing required metadata' });
                    continue;
                }

                try {
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

                    const { path: folderPath, ignored } = await resolveFolderPath(drive, parentId, driveId, pathCache);

                    if (ignored) {
                        skipped.push({ fileId, reason: `Folder tagged [relay-ignore]: ${folderPath}` });
                        logger.info('ingest', `Skipped ${file.name} — folder tagged [relay-ignore]`, { folderPath });
                        continue;
                    }

                    if (!isInSyncScope(folderPath, syncFolders)) {
                        skipped.push({ fileId, reason: `Not in sync scope: ${folderPath}` });
                        logger.info('ingest', `Skipped ${file.name} — not in sync scope`, { folderPath });
                        continue;
                    }

                    // Parse rights labels
                    const rights = labelId
                        ? parseLabelFields(file, labelId, config.rightsLabelConfig)
                        : emptyRightsFields();

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
                        webViewLink: file.webViewLink ?? null,
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
                        fileSize: file.size ? Number(file.size) : null,
                    });
                } catch (err) {
                    // Per-file isolation — one malformed file must not fail the batch
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${fileId}: ${msg}`);
                    logger.error('ingest', `Failed to process file ${fileId}`, { error: msg });
                }
            }

            // Small pause between chunks to stay clear of Drive rate limits
            if (chunkStart + FETCH_CHUNK < fileIds.length) {
                await new Promise(r => setTimeout(r, 100));
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
        const { upserted, errors: upsertErrors } = await upsertAssets(driveFiles);

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
        const adminClient = getAdminClient();

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
            for (const [folderDriveId, info] of pathCache.entries()) {
                // Ignored folders hold no assets — keep them out of the mapping
                if (!info.ignored) folderIdMap[info.path] = folderDriveId;
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
