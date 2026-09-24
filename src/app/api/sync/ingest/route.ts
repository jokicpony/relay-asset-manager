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
import { isAssetMime } from '@/lib/sync/mime';
import { DRIVE_FILE_FIELDS, toDriveFile } from '@/lib/sync/drive-file';
import { withDriveRetry } from '@/lib/sync/drive-retry';
import { embedInputsChanged, EMBED_INPUT_COLUMNS, type EmbedInputs } from '@/lib/embedding-text';
import { resolveFolderPathById, type FolderInfo } from '@/lib/google/folder-path';
import { isDriveId } from '@/lib/google/drive-scope';

// One Namer batch per request; the queue ingests per batch
const MAX_INGEST_FILES = 500;
import { parseLabelFields, emptyRightsFields } from '@/lib/sync/rights-labels';
import { getConfig } from '@/lib/config';
import { normalizeSyncFolders, isInSyncScope } from '@/lib/sync/scope';
import { logger } from '@/lib/logger';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import type { DriveFile } from '@/lib/sync/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120; // 2 min max — targeted ingest is fast

// ---------------------------------------------------------------------------
// Activity log — every ingest writes a sync_logs row (source 'ingest') so
// failures are traceable in Settings → Recent activity, not only in the
// requesting browser's Namer queue or Vercel's short-lived logs.
// ---------------------------------------------------------------------------
async function recordIngest(entry: {
    startedAt: number;
    status: 'success' | 'partial' | 'failed';
    requested: number;
    upserted: number;
    upsertErrors: number;
    thumbnails: number;
    thumbnailErrors: number;
    errorMessage: string | null;
    details: Record<string, unknown>;
}) {
    const finished = Date.now();
    const { error } = await getAdminClient().from('sync_logs').insert({
        started_at: new Date(entry.startedAt).toISOString(),
        finished_at: new Date(finished).toISOString(),
        duration_secs: (finished - entry.startedAt) / 1000,
        assets_found: entry.requested,
        assets_upserted: entry.upserted,
        upsert_errors: entry.upsertErrors,
        thumbnails_uploaded: entry.thumbnails,
        thumbnail_errors: entry.thumbnailErrors,
        status: entry.status,
        error_message: entry.errorMessage?.slice(0, 1000) ?? null,
        source: 'ingest',
        details: entry.details,
    });
    // Never fail the ingest over its own log entry
    if (error) logger.warn('ingest', 'Could not write activity log', { error: error.message });
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

    // Thumbnails stop starting new work at this point, leaving time for the
    // DB updates and folder-map merge before the 120s limit. Anything
    // deferred has no thumbnail row yet, so the cron picks it up.
    const startedAt = Date.now();
    const thumbnailDeadline = startedAt + 80_000;
    let requestedCount = 0;
    let destFolderForLog: string | null = null;

    try {
        const { fileIds, destFolderId } = await request.json();
        requestedCount = Array.isArray(fileIds) ? fileIds.length : 0;
        destFolderForLog = typeof destFolderId === 'string' ? destFolderId : null;

        if (!Array.isArray(fileIds) || fileIds.length === 0 || !destFolderId) {
            return NextResponse.json(
                { error: 'fileIds (array) and destFolderId are required' },
                { status: 400 }
            );
        }
        if (fileIds.length > MAX_INGEST_FILES || !fileIds.every(isDriveId)) {
            return NextResponse.json(
                { error: `fileIds must be at most ${MAX_INGEST_FILES} valid Drive file IDs` },
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

        // Request-scoped folder cache (path + inherited [relay-ignore] flag)
        const pathCache = new Map<string, FolderInfo>();

        const syncFolders = normalizeSyncFolders(config.syncFolders);
        const labelId = config.driveLabelId;

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
                    // One retry layer: the client's built-in retry is off so
                    // attempts don't multiply past the route's time limit.
                    const res = await withDriveRetry(() => drive.files.get({
                        fileId,
                        fields: DRIVE_FILE_FIELDS,
                        supportsAllDrives: true,
                        includeLabels: labelId || undefined,
                    }, { retry: false }), `files.get ${fileId}`, (m) => logger.warn('ingest', m), 3);
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
                    if (!isAssetMime(file.mimeType)) {
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

                    // The service account can see more than the library's
                    // shared drive (other drives, files shared with it). Only
                    // files that live in the shared drive may be ingested —
                    // checked before resolving the path, so nothing about
                    // outside files is echoed back either.
                    if (file.driveId !== driveId) {
                        skipped.push({ fileId, reason: 'Not in the shared drive' });
                        continue;
                    }

                    const { path: folderPath, ignored } = await resolveFolderPathById(accessToken, parentId, driveId, pathCache);
                    if (folderPath === '/unknown') {
                        skipped.push({ fileId, reason: 'Folder path could not be resolved' });
                        continue;
                    }

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

                    // Rights labels + the shared Drive → DriveFile mapping
                    const rights = labelId
                        ? parseLabelFields(file, labelId, config.rightsLabelConfig)
                        : emptyRightsFields();
                    driveFiles.push(toDriveFile(file, folderPath, rights));
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
            await recordIngest({
                startedAt, status: errors.length > 0 ? 'failed' : 'partial',
                requested: fileIds.length, upserted: 0, upsertErrors: 0, thumbnails: 0, thumbnailErrors: 0,
                errorMessage: `Nothing ingested: ${skipped.length} skipped, ${errors.length} errors`
                    + (errors[0] ? ` (first error: ${errors[0]})` : skipped[0] ? ` (first skip: ${skipped[0].reason})` : ''),
                details: { user: user.email ?? null, destFolderId, errors, skipped },
            });
            return NextResponse.json({
                ingested: 0,
                thumbnails: 0,
                skipped,
                errors,
            });
        }

        // Embedding inputs of files already in the library, before this upsert.
        // The ingest doesn't embed; if a re-ingest changes what the embedding
        // is built from (rename, move, new description), the embedding is
        // cleared below so the scheduled sync regenerates it. The sync can't
        // detect this itself — by then its snapshot already has the new values.
        const adminClient = getAdminClient();
        const before = new Map<string, EmbedInputs>();
        const ids = driveFiles.map(f => f.id);
        for (let i = 0; i < ids.length; i += 150) {
            const { data, error: beforeErr } = await adminClient
                .from('assets')
                .select(`drive_file_id, ${EMBED_INPUT_COLUMNS}`)
                .in('drive_file_id', ids.slice(i, i + 150));
            if (beforeErr) errors.push(`Could not read existing rows (changed files may keep stale search embeddings): ${beforeErr.message}`);
            for (const { drive_file_id, ...inputs } of (data ?? []) as unknown as (EmbedInputs & { drive_file_id: string })[]) {
                before.set(drive_file_id, inputs);
            }
        }

        // ── Upsert assets into the database ──
        logger.info('ingest', `Upserting ${driveFiles.length} assets`);
        const { upserted, errors: upsertErrors } = await upsertAssets(driveFiles, { labelsFetched: !!labelId });

        const staleEmbeddings = driveFiles.filter(f => {
            const prev = before.get(f.id);
            return prev && embedInputsChanged(prev, {
                name: f.name,
                description: f.description,
                folder_path: f.folderPath,
                parsed_creator: f.parsedCreator,
                parsed_shoot_description: f.parsedShootDescription,
            });
        }).map(f => f.id);
        for (let i = 0; i < staleEmbeddings.length; i += 150) {
            const chunk = staleEmbeddings.slice(i, i + 150);
            const { error: clearErr } = await adminClient
                .from('assets')
                .update({ embedding: null })
                .in('drive_file_id', chunk);
            if (clearErr) errors.push(`Could not mark ${chunk.length} embeddings for refresh: ${clearErr.message}`);
        }
        if (staleEmbeddings.length > 0) {
            logger.info('ingest', `Marked ${staleEmbeddings.length} changed assets for re-embedding`);
        }

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

        const urlMap = await processThumbnails(accessToken, thumbFiles, thumbnailDeadline);

        // Update thumbnail URLs in the database

        // In parallel (10 at a time) — one-by-one updates ate into the time
        // limit after the thumbnail deadline on large batches
        let thumbnailsUpdated = 0;
        const thumbEntries = [...urlMap];
        for (let i = 0; i < thumbEntries.length; i += 10) {
            const results = await Promise.all(thumbEntries.slice(i, i + 10).map(([driveFileId, { url, color }]) =>
                adminClient
                    .from('assets')
                    .update({ thumbnail_url: url, ...(color ? { thumb_color: color } : {}) })
                    .eq('drive_file_id', driveFileId)));
            thumbnailsUpdated += results.filter(r => !r.error).length;
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

        const missingThumbs = driveFiles.length - urlMap.size;
        const summary = [
            errors.length > 0 && `${errors.length} errors (first: ${errors[0]})`,
            skipped.length > 0 && `${skipped.length} skipped (first: ${skipped[0].reason})`,
            missingThumbs > 0 && `${missingThumbs} without a thumbnail yet — the scheduled sync retries`,
        ].filter(Boolean).join(' · ');
        await recordIngest({
            startedAt,
            status: summary ? 'partial' : 'success',
            requested: fileIds.length,
            upserted,
            upsertErrors: upsertErrors.length,
            thumbnails: thumbnailsUpdated,
            thumbnailErrors: missingThumbs,
            errorMessage: summary || null,
            details: { user: user.email ?? null, destFolderId, errors, skipped },
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
        await recordIngest({
            startedAt, status: 'failed', requested: requestedCount,
            upserted: 0, upsertErrors: 0, thumbnails: 0, thumbnailErrors: 0,
            errorMessage: `Ingest failed: ${message}`,
            details: { user: user.email ?? null, destFolderId: destFolderForLog },
        });
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
