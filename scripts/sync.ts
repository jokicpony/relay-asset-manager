#!/usr/bin/env npx tsx
/**
 * Relay Asset Manager — Standalone Sync Script
 *
 * Usage:  npx tsx scripts/sync.ts
 *
 * Prerequisites:
 *   1. Dev server running (npm run dev)
 *   2. Signed in via the browser (Google OAuth)
 *
 * This script:
 *   1. Grabs your Google token from the running dev server session
 *   2. Crawls the Shared Drive (respecting SYNC_FOLDERS allowlist)
 *   3. Downloads thumbnails → uploads to Supabase Storage
 *   4. Upserts everything to the assets table
 *   5. Shows real-time progress in the terminal
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseFilename } from '../src/lib/filename-utils';
import { buildEmbedText } from '../src/lib/embedding-text';
import type { EmbeddableAssetRow } from '../src/lib/embedding-text';
import { IMAGE_MIMES, VIDEO_MIMES, SHORTCUT_MIME, isAssetMime } from '../src/lib/sync/mime';
import { parseLabelFields as parseRightsLabelFields } from '../src/lib/sync/rights-labels';
import type { RightsLabelConfig } from '../src/lib/sync/rights-labels';
import { buildAssetRow } from '../src/lib/sync/asset-row';
import { encodeThumbnail, THUMBNAIL_MAX_PX } from '../src/lib/sync/thumbnail-encode';
import { PURGE_AFTER_DAYS, SHORTCUT_GRACE_DAYS } from '../src/lib/sync/constants';
import type { DriveFile as SharedDriveFile } from '../src/lib/sync/types';

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let DRIVE_ID = process.env.GOOGLE_SHARED_DRIVE_ID || '';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents';

// Progress stream mode — output JSON lines for SSE piping
const PROGRESS_STREAM = process.argv.includes('--progress-stream');

// Thumbnail step: parallel Drive fetches, capped by a wall-clock budget so a
// backlog can't push the job past its timeout (see processThumbnails).
const THUMBNAIL_CONCURRENCY = 8;
const THUMBNAIL_BUDGET_MS = (Number(process.env.SYNC_THUMBNAIL_BUDGET_MIN) || 15) * 60_000;

// Mass-orphan circuit breaker (see detectOrphans). A run that would trash
// more than this many assets as `orphaned` skips that soft-delete instead.
// Override for a genuine bulk deletion: --allow-mass-orphan.
const MASS_ORPHAN_MIN = 100;
const MASS_ORPHAN_FRACTION = 0.1;
const ALLOW_MASS_ORPHAN = process.argv.includes('--allow-mass-orphan');

// Persist sync progress to Supabase so the frontend can poll it.
// Fire-and-forget — never block the sync pipeline on a progress write.
let _lastProgressWrite = 0;
function persistProgress(step: string, detail: string, pct?: number) {
    const now = Date.now();
    // Throttle DB writes to at most once per 3 seconds (except for step changes)
    if (now - _lastProgressWrite < 3000 && pct !== undefined && pct !== 100) return;
    _lastProgressWrite = now;

    try {
        const supabase = getSupabase();
        supabase
            .from('app_settings')
            .upsert({
                key: 'sync_progress',
                value: { step, detail, pct: pct ?? null, updated_at: new Date().toISOString() },
                updated_at: new Date().toISOString(),
            })
            .then(() => {});
    } catch { /* never block sync */ }
}

function emitProgress(step: string, detail: string, pct?: number) {
    if (PROGRESS_STREAM) {
        console.log(JSON.stringify({ step, detail, pct: pct ?? null, ts: Date.now() }));
    }
    persistProgress(step, detail, pct);
}

// Types for crawl results
interface CrawlStats {
    skippedByFolder: number;
    skippedByIgnore: number;
    ignoredFolders: { name: string; path: string; tagged: boolean }[];
}
interface CrawlResult {
    files: DriveFile[];
    folderIdMap: Record<string, string>;
    stats: CrawlStats;
}

// Pre-fetched folder tree data shared across crawl + shortcut phases
interface FolderTree {
    pathCache: Map<string, string>;           // folderId → full path
    ignoredFolderIds: Set<string>;            // all ignored folder IDs (direct + inherited)
    directlyTaggedIds: Set<string>;           // only folders with [relay-ignore] tag
    folderIdMap: Record<string, string>;      // path → folderId (inverted map)
}

// Shared Supabase admin client — reused across all sync functions.
// Service role only: under RLS lockdown, anon-key writes silently affect
// zero rows, so a missing key must abort the run instead of no-op syncing.
// Typed as bare SupabaseClient, not ReturnType<typeof createClient> — the
// inferred type degrades mutation payloads to `never` without generated
// schema types, which forced `as any` casts on every write.
let _supabase: SupabaseClient | null = null;
function getSupabase() {
    if (!_supabase) {
        if (!SUPABASE_SERVICE_KEY) {
            throw new Error('SUPABASE_SERVICE_ROLE_KEY is required — sync writes cannot use the anon key');
        }
        _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    }
    return _supabase;
}
let SYNC_FOLDERS: string[] = [];
let RIGHTS_LABEL_ID = '';

// Rights label field IDs and choice mappings — loaded from app_settings.
// Type is shared with the app (src/lib/sync/rights-labels).
let rightsLabelConfig: RightsLabelConfig = {
    fieldIds: { organicRights: '', organicExpiration: '', paidRights: '', paidExpiration: '' },
    choiceMap: {},
};

// ---------------------------------------------------------------------------
// Load centralized settings from Supabase app_settings table
// Falls back to env vars if DB is unavailable or values are missing.
// ---------------------------------------------------------------------------
async function loadConfig(): Promise<void> {
    try {
        const supabase = getSupabase();
        const { data } = await supabase
            .from('app_settings')
            .select('key, value');

        const settings = new Map<string, unknown>();
        if (!data || data.length === 0) {
            log('  ℹ️  No app_settings rows found — using env var fallbacks');
        } else {
            for (const row of (data as { key: string; value: unknown }[])) settings.set(row.key, row.value);
        }

        if (settings.has('shared_drive_id')) {
            DRIVE_ID = settings.get('shared_drive_id') as string;
        }
        if (settings.has('sync_folders')) {
            const folders = settings.get('sync_folders') as string[];
            if (Array.isArray(folders) && folders.length > 0) {
                SYNC_FOLDERS = folders.map(f => f.trim().toLowerCase()).filter(Boolean);
            }
        }
        if (settings.has('drive_label_id')) {
            RIGHTS_LABEL_ID = settings.get('drive_label_id') as string;
        }
        if (settings.has('rights_label_config')) {
            rightsLabelConfig = settings.get('rights_label_config') as RightsLabelConfig;
        }

        log('  ✅ Loaded settings from database (app_settings)');
    } catch {
        log('  ⚠️  Could not load app_settings — using env var fallbacks');
    }

    // Env var fallbacks for values not found in DB (local dev)
    if (!DRIVE_ID && process.env.GOOGLE_SHARED_DRIVE_ID) {
        DRIVE_ID = process.env.GOOGLE_SHARED_DRIVE_ID;
    }
    if (SYNC_FOLDERS.length === 0 && process.env.SYNC_FOLDERS) {
        SYNC_FOLDERS = process.env.SYNC_FOLDERS.split(',').map(f => f.trim().toLowerCase()).filter(Boolean);
    }
    if (!RIGHTS_LABEL_ID && process.env.GOOGLE_DRIVE_LABEL_ID) {
        RIGHTS_LABEL_ID = process.env.GOOGLE_DRIVE_LABEL_ID;
    }

    // Guard: shared_drive_id is required for sync to do anything useful
    if (!DRIVE_ID) {
        throw new Error(
            'shared_drive_id is not configured. Set it in Settings → Advanced or the GOOGLE_SHARED_DRIVE_ID env var.'
        );
    }
}

// MIME sets are shared with the app (src/lib/sync/mime), and filename
// parsing is shared with the app (src/lib/filename-utils) so the
// overnight sync and the namer's targeted ingest write identical
// parsed_creator / parsed_shoot_description values for the same file.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
}

function progress(current: number, total: number, label: string) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2)) + '░'.repeat(50 - Math.round(pct / 2));
    process.stdout.write(`\r  ${bar} ${pct}% (${current}/${total}) ${label}`);
    if (current === total) process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Drive API retry wrapper — exponential backoff for rate limit errors
// ---------------------------------------------------------------------------
const DRIVE_MAX_RETRIES = 5;

async function withDriveRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; attempt <= DRIVE_MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (rawErr) {
            // Google API errors are untyped — narrow to the fields we inspect
            const err = rawErr as {
                code?: number;
                status?: number;
                message?: string;
                response?: { status?: number };
                errors?: { reason?: string }[];
            };
            const status = err?.code ?? err?.response?.status ?? err?.status;
            const reason = err?.errors?.[0]?.reason ?? '';
            const isRateLimit =
                status === 429 ||
                status === 403 && (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded') ||
                (err?.message ?? '').includes('User rate limit exceeded') ||
                (err?.message ?? '').includes('Rate limit exceeded');

            if (isRateLimit && attempt < DRIVE_MAX_RETRIES) {
                const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
                log(`  ⚠️  Rate limited on ${label} (attempt ${attempt + 1}/${DRIVE_MAX_RETRIES + 1}), retrying in ${(backoff / 1000).toFixed(1)}s...`);
                await sleep(backoff);
                continue;
            }
            throw rawErr;
        }
    }
    throw new Error(`Drive API call failed after ${DRIVE_MAX_RETRIES + 1} attempts: ${label}`);
}

// ---------------------------------------------------------------------------
// Pre-fetch entire folder hierarchy in one pass
// Replaces hundreds of individual files.get() calls with a few pages of
// files.list() filtered to folders only.
// ---------------------------------------------------------------------------
async function prefetchFolderTree(accessToken: string): Promise<FolderTree> {
    log('📁 Pre-fetching folder hierarchy...');
    emitProgress('folders', 'Fetching folder tree...');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    // Fetch ALL folders in the shared drive
    interface FolderInfo {
        name: string;
        parentId: string | null;
        description: string | null;
    }
    const folders = new Map<string, FolderInfo>();
    let pageToken: string | undefined;
    let pageNum = 0;

    do {
        pageNum++;
        const res = await withDriveRetry(
            () => drive.files.list({
                q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
                driveId: DRIVE_ID,
                corpora: 'drive',
                includeItemsFromAllDrives: true,
                supportsAllDrives: true,
                fields: 'nextPageToken,files(id,name,parents,description)',
                pageSize: 1000,
                pageToken,
            }),
            `folder list page ${pageNum}`
        );

        for (const file of res.data.files || []) {
            if (!file.id || !file.name) continue;
            folders.set(file.id, {
                name: file.name,
                parentId: file.parents?.[0] ?? null,
                description: file.description ?? null,
            });
        }

        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    log(`  Fetched ${folders.size} folders in ${pageNum} page(s)`);

    // Build full paths from the in-memory tree (zero API calls)
    const pathCache = new Map<string, string>();
    const ignoredFolderIds = new Set<string>();
    const directlyTaggedIds = new Set<string>();

    function buildPath(folderId: string): string {
        if (folderId === DRIVE_ID) return '/';
        if (pathCache.has(folderId)) return pathCache.get(folderId)!;

        const folder = folders.get(folderId);
        if (!folder) return '/unknown';

        // Check for [relay-ignore] tag
        if (folder.description?.includes('[relay-ignore]')) {
            ignoredFolderIds.add(folderId);
            directlyTaggedIds.add(folderId);
        }

        const parentPath = folder.parentId ? buildPath(folder.parentId) : '/';
        const fullPath = parentPath === '/' ? `/${folder.name}` : `${parentPath}/${folder.name}`;
        pathCache.set(folderId, fullPath);

        // Cascade ignore from parent
        if (folder.parentId && ignoredFolderIds.has(folder.parentId)) {
            ignoredFolderIds.add(folderId);
        }

        return fullPath;
    }

    // Resolve all folders
    for (const folderId of folders.keys()) {
        buildPath(folderId);
    }

    // Build inverted map: path → folderId
    const folderIdMap: Record<string, string> = {};
    for (const [folderId, path] of pathCache.entries()) {
        folderIdMap[path] = folderId;
    }

    log(`  ✅ Resolved ${pathCache.size} folder paths (${ignoredFolderIds.size} ignored)`);
    if (ignoredFolderIds.size > 0) {
        for (const folderId of directlyTaggedIds) {
            log(`     🚫 ${pathCache.get(folderId) || folderId}`);
        }
    }
    emitProgress('folders', `${pathCache.size} folders resolved`, 100);

    return { pathCache, ignoredFolderIds, directlyTaggedIds, folderIdMap };
}

// ---------------------------------------------------------------------------
// Step 0: Get Google access token
// Tries (in order): WIF/ADC, dev server session, env var, stored token
// ---------------------------------------------------------------------------
async function getAccessToken(): Promise<string> {
    log('🔑 Getting Google access token...');

    // 1. Try Application Default Credentials (WIF in GitHub Actions or local ADC)
    //    google-github-actions/auth sets GOOGLE_APPLICATION_CREDENTIALS automatically
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
        try {
            const { GoogleAuth } = await import('google-auth-library');
            const auth = new GoogleAuth({
                scopes: [
                    'https://www.googleapis.com/auth/drive',
                    'https://www.googleapis.com/auth/drive.labels',
                    'https://www.googleapis.com/auth/drive.labels.readonly',
                ],
            });
            const client = await auth.getClient();
            const tokenResponse = await client.getAccessToken();
            const token = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
            if (token) {
                log('  ✅ Got access token via Application Default Credentials (WIF)');
                return token;
            }
        } catch (err) {
            log(`  ⚠️  ADC/WIF auth failed: ${err}`);
        }
    }

    // 2. Fallback: use GOOGLE_REFRESH_TOKEN env var
    const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    if (envRefreshToken) {
        log('  Using GOOGLE_REFRESH_TOKEN from environment...');
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: envRefreshToken,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }),
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
            log('  ✅ Got access token via env refresh token');
            return tokenData.access_token;
        }
        throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
    }

    throw new Error(
        'Could not get Google access token.\n' +
        '  Make sure:\n' +
        '  1. GOOGLE_APPLICATION_CREDENTIALS is set (WIF / service account), or\n' +
        '  2. GOOGLE_REFRESH_TOKEN is set in your environment'
    );
}

// ---------------------------------------------------------------------------
// Step 1: Crawl Drive
// ---------------------------------------------------------------------------
// The crawler's file shape is the shared ingest shape minus the fields the
// crawler doesn't carry: filename parsing happens at upsert time, and
// creator / project_description are user- or namer-managed. Deriving via
// Omit keeps the two paths' columns from drifting apart.
type DriveFile = Omit<
    SharedDriveFile,
    'creator' | 'projectDescription' | 'parsedCreator' | 'parsedShootDate' | 'parsedShootDescription'
>;

// ---------------------------------------------------------------------------
// Label field parser — shared implementation (src/lib/sync/rights-labels),
// wrapped to log the first labeled file for debugging.
// ---------------------------------------------------------------------------

let _labelFieldsLogged = false;

function parseLabelFields(file: unknown, fileName?: string) {
    return parseRightsLabelFields(file, RIGHTS_LABEL_ID, rightsLabelConfig, (fields) => {
        if (_labelFieldsLogged) return;
        _labelFieldsLogged = true;
        log(`\n  🏷️  Label data discovered on: ${fileName || 'unknown'}`);
        for (const [fId, fVal] of Object.entries(fields)) {
            log(`     Field ${fId}: ${JSON.stringify(fVal)}`);
        }
        log('');
    });
}

async function crawlDrive(accessToken: string, folderTree: FolderTree): Promise<CrawlResult> {
    log('📂 Crawling Google Drive...');
    if (SYNC_FOLDERS.length > 0) {
        log(`  Allowlist: ${SYNC_FOLDERS.join(', ')}`);
    } else {
        log('  Syncing ALL folders (no SYNC_FOLDERS filter)');
    }

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });

    const { pathCache, ignoredFolderIds, directlyTaggedIds } = folderTree;
    const results: DriveFile[] = [];

    // Resolve folder path from pre-fetched tree (zero API calls)
    function resolvePath(parents: string[] | null | undefined): string {
        if (!parents || parents.length === 0) return '/';
        const parentId = parents[0];
        if (parentId === DRIVE_ID) return '/';
        return pathCache.get(parentId) ?? '/unknown';
    }

    // Check if a file's parent folder (or any ancestor) is ignored
    function isIgnored(parents: string[] | null | undefined): boolean {
        if (!parents) return false;
        return parents.some((p) => ignoredFolderIds.has(p));
    }

    // Build query
    const mimeFilter = [...IMAGE_MIMES, ...VIDEO_MIMES].map((m) => `mimeType='${m}'`).join(' or ');
    const query = `(${mimeFilter}) and trashed=false`;
    const fields = 'nextPageToken,files(id,name,mimeType,size,description,parents,thumbnailLink,webViewLink,labelInfo,createdTime,modifiedTime,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis))';

    let pageToken: string | undefined;
    let totalScanned = 0;
    let skippedByFolder = 0;
    let skippedByIgnore = 0;

    let pageNum = 0;

    do {
        pageNum++;
        emitProgress('crawl', `Scanning page ${pageNum} — ${results.length} assets found so far...`);

        const res = await withDriveRetry(
            () => drive.files.list({
                q: query,
                driveId: DRIVE_ID,
                corpora: 'drive',
                includeItemsFromAllDrives: true,
                supportsAllDrives: true,
                includeLabels: RIGHTS_LABEL_ID,
                fields,
                pageSize: 1000, // Drive may return fewer per page; nextPageToken handles it
                pageToken,
            }),
            `asset list page ${pageNum}`
        );

        const files = res.data.files || [];
        totalScanned += files.length;

        for (const file of files) {
            if (!file.id || !file.name || !file.mimeType) continue;
            if (!isAssetMime(file.mimeType)) continue;

            const folderPath = resolvePath(file.parents);

            // Allowlist check
            if (SYNC_FOLDERS.length > 0) {
                const topFolder = folderPath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
                if (!SYNC_FOLDERS.some((f) => topFolder === f)) {
                    skippedByFolder++;
                    continue;
                }
            }

            // [relay-ignore] check — skip files in ignored folders
            if (isIgnored(file.parents)) {
                skippedByIgnore++;
                continue;
            }

            const isVideo = VIDEO_MIMES.has(file.mimeType);
            const width = isVideo
                ? file.videoMediaMetadata?.width ?? 0
                : file.imageMediaMetadata?.width ?? 0;
            const height = isVideo
                ? file.videoMediaMetadata?.height ?? 0
                : file.imageMediaMetadata?.height ?? 0;
            const duration = isVideo && file.videoMediaMetadata?.durationMillis
                ? Number(file.videoMediaMetadata.durationMillis) / 1000
                : null;

            // Parse Rights Management label
            const rights = parseLabelFields(file, file.name);

            results.push({
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
                createdTime: file.createdTime ?? new Date().toISOString(),
                modifiedTime: file.modifiedTime ?? new Date().toISOString(),
                fileSize: file.size ? Number(file.size) : null,
                organicRights: rights.organicRights,
                organicRightsExpiration: rights.organicRightsExpiration,
                paidRights: rights.paidRights,
                paidRightsExpiration: rights.paidRightsExpiration,
            });
        }

        progress(results.length, results.length, `found (${totalScanned} scanned, ${skippedByFolder} folder-skipped, ${skippedByIgnore} ignored)`);

        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    const labeledCount = results.filter((r) => r.organicRights || r.paidRights).length;
    const previewCount = results.filter((r) => r.webViewLink).length;
    log(`  ✅ Found ${results.length} assets (${skippedByFolder} skipped by folder filter, ${skippedByIgnore} skipped by [relay-ignore])`);

    // Collect ignored folder details for sync log
    const ignoredFolderDetails: { name: string; path: string; tagged: boolean }[] = [];
    for (const folderId of ignoredFolderIds) {
        const path = pathCache.get(folderId) || '/unknown';
        const name = path.split('/').filter(Boolean).pop() || 'unknown';
        ignoredFolderDetails.push({ name, path, tagged: directlyTaggedIds.has(folderId) });
    }
    if (ignoredFolderDetails.length > 0) {
        log(`  🚫 ${ignoredFolderDetails.length} folder(s) tagged with [relay-ignore]`);
        for (const f of ignoredFolderDetails) log(`     → ${f.path}`);
    }
    log(`     📎 ${labeledCount} with rights labels, ${previewCount} with preview URLs`);
    emitProgress('crawl', `Found ${results.length} assets`, 100);

    return {
        files: results,
        folderIdMap: folderTree.folderIdMap,
        stats: { skippedByFolder, skippedByIgnore, ignoredFolders: ignoredFolderDetails },
    };
}

// ---------------------------------------------------------------------------
// Step 1b: Resolve Shortcuts — discover shortcuts to image/video assets
// ---------------------------------------------------------------------------
interface ShortcutResult {
    resolved: number;
    matched: number;
    failed: number;
    orphansRemoved: number;
}

async function resolveShortcuts(
    accessToken: string,
    crawledFiles: DriveFile[],
    folderTree: FolderTree,
): Promise<ShortcutResult> {
    log('🔗 Resolving Google Drive shortcuts...');
    emitProgress('shortcuts', 'Discovering shortcuts...');

    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    const drive = google.drive({ version: 'v3', auth });
    const supabase = getSupabase();

    // Use shared folder tree — no duplicate API calls
    const { pathCache, ignoredFolderIds } = folderTree;

    function resolveFolderPath(parents: string[] | null | undefined): string {
        if (!parents || parents.length === 0) return '/';
        const parentId = parents[0];
        if (parentId === DRIVE_ID) return '/';
        return pathCache.get(parentId) ?? '/unknown';
    }

    // 1. Query Drive for all shortcuts
    const query = `mimeType='${SHORTCUT_MIME}' and trashed=false`;
    const fields = 'nextPageToken,files(id,name,parents,shortcutDetails)';
    let pageToken: string | undefined;
    const shortcuts: {
        id: string;
        name: string;
        parents: string[];
        targetId: string;
        targetMimeType: string;
    }[] = [];

    let scPageNum = 0;
    do {
        scPageNum++;
        emitProgress('shortcuts', `Discovering shortcuts — page ${scPageNum}, ${shortcuts.length} found...`);

        const res = await withDriveRetry(
            () => drive.files.list({
                q: query,
                driveId: DRIVE_ID,
                corpora: 'drive',
                includeItemsFromAllDrives: true,
                supportsAllDrives: true,
                fields,
                pageSize: 1000, // Drive may return fewer per page; nextPageToken handles it
                pageToken,
            }),
            `shortcut list page ${scPageNum}`
        );

        for (const file of res.data.files || []) {
            if (!file.id || !file.shortcutDetails?.targetId || !file.shortcutDetails?.targetMimeType) continue;
            // Only care about shortcuts pointing to images/videos
            if (!isAssetMime(file.shortcutDetails.targetMimeType)) continue;

            shortcuts.push({
                id: file.id,
                name: file.name || 'untitled',
                parents: (file.parents as string[]) || [],
                targetId: file.shortcutDetails.targetId,
                targetMimeType: file.shortcutDetails.targetMimeType,
            });
        }

        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    log(`  Found ${shortcuts.length} shortcuts to image/video assets`);

    if (shortcuts.length === 0) {
        // Still clean up orphaned shortcuts
        const orphansRemoved = await cleanupOrphanedShortcuts(supabase, new Set());
        log('  ✅ No shortcuts to resolve');
        return { resolved: 0, matched: 0, failed: 0, orphansRemoved };
    }

    // 2. Filter by SYNC_FOLDERS allowlist + [relay-ignore]
    const filteredShortcuts: (typeof shortcuts[number] & { folderPath: string; parentId: string })[] = [];
    let skippedByFolder = 0;
    let skippedByIgnore = 0;

    for (const sc of shortcuts) {
        const folderPath = resolveFolderPath(sc.parents);

        // Allowlist check
        if (SYNC_FOLDERS.length > 0) {
            const topFolder = folderPath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
            if (!SYNC_FOLDERS.some((f) => topFolder === f)) {
                skippedByFolder++;
                continue;
            }
        }

        // [relay-ignore] check
        if (sc.parents.some((p) => ignoredFolderIds.has(p))) {
            skippedByIgnore++;
            continue;
        }

        filteredShortcuts.push({ ...sc, folderPath, parentId: sc.parents[0] || '' });
    }

    if (skippedByFolder > 0 || skippedByIgnore > 0) {
        log(`  Filtered: ${skippedByFolder} outside SYNC_FOLDERS, ${skippedByIgnore} in [relay-ignore]`);
    }
    log(`  ${filteredShortcuts.length} shortcuts in synced folders`);

    // 3. Fetch asset UUIDs for all target drive_file_ids
    const allTargetIds = [...new Set(filteredShortcuts.map(sc => sc.targetId))];
    const targetToAssetId = new Map<string, string>();

    const DB_BATCH = 150; // keeps the .in() query string well under URL limits
    for (let i = 0; i < allTargetIds.length; i += DB_BATCH) {
        const batch = allTargetIds.slice(i, i + DB_BATCH);
        const { data } = await supabase
            .from('assets')
            .select('id, drive_file_id')
            .in('drive_file_id', batch);

        if (data) {
            for (const row of (data as { id: string; drive_file_id: string }[])) {
                targetToAssetId.set(row.drive_file_id, row.id);
            }
        }
    }

    // 4. Upsert to shortcuts table
    let matched = 0;
    let failed = 0;
    const upsertRows: Record<string, string>[] = [];
    const discoveredShortcutIds = new Set<string>();

    for (const sc of filteredShortcuts) {
        discoveredShortcutIds.add(sc.id);
        const assetId = targetToAssetId.get(sc.targetId);

        if (!assetId) {
            failed++;
            continue;
        }

        matched++;
        upsertRows.push({
            shortcut_drive_id: sc.id,
            target_asset_id: assetId,
            project_folder_path: sc.folderPath,
            project_folder_drive_id: sc.parentId,
        });
    }

    // Batch upsert
    const BATCH = 50;
    for (let i = 0; i < upsertRows.length; i += BATCH) {
        const batch = upsertRows.slice(i, i + BATCH);
        const { error } = await supabase
            .from('shortcuts')
            .upsert(batch, { onConflict: 'shortcut_drive_id', ignoreDuplicates: false });

        if (error) {
            log(`  ❌ Shortcut upsert error: ${error.message}`);
        }

        const done = Math.min(i + BATCH, upsertRows.length);
        const pct = Math.round((done / upsertRows.length) * 100);
        emitProgress('shortcuts', `Upserting shortcuts — ${done}/${upsertRows.length}`, pct);
        progress(done, upsertRows.length, 'shortcuts upserted');
    }

    // 5. Clean up orphaned shortcuts
    const orphansRemoved = await cleanupOrphanedShortcuts(supabase, discoveredShortcutIds);

    log(`  ✅ Resolved ${filteredShortcuts.length} shortcuts → ${matched} matched, ${failed} targets not in library`);
    if (orphansRemoved > 0) log(`  🗑️  Removed ${orphansRemoved} shortcuts (missing from Drive > ${SHORTCUT_GRACE_DAYS} days)`);
    emitProgress('shortcuts', `${matched} shortcuts matched`, 100);

    return { resolved: filteredShortcuts.length, matched, failed, orphansRemoved };
}

async function cleanupOrphanedShortcuts(
    supabase: SupabaseClient,
    discoveredIds: Set<string>,
): Promise<number> {
    // Fetch all shortcuts in DB (paginated — PostgREST caps a select at 1000
    // rows, and rows past the cap would never be marked missing or cleaned up)
    const rows: { id: string; shortcut_drive_id: string; missing_since: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
            .from('shortcuts')
            .select('id, shortcut_drive_id, missing_since')
            .order('id')
            .range(from, from + 999);
        if (error) return 0;
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }

    // Grace period instead of immediate deletion: a transient Drive listing
    // anomaly must not wipe the table — relay badges, the sidebar's virtual
    // project folders, and the shortcut-delete route's tracked-shortcut
    // authorization all read it. Undiscovered rows are marked missing_since
    // (and still served to the app); only rows whose mark survives
    // SHORTCUT_GRACE_DAYS get hard-deleted. The cost: a shortcut genuinely
    // deleted in Drive keeps its badge for up to the grace period.
    const cutoffMs = Date.now() - SHORTCUT_GRACE_DAYS * 24 * 60 * 60 * 1000;

    const reappeared = rows
        .filter((r) => discoveredIds.has(r.shortcut_drive_id) && r.missing_since)
        .map((r) => r.id);
    const missing = rows.filter((r) => !discoveredIds.has(r.shortcut_drive_id));
    const newlyMissing = missing.filter((r) => !r.missing_since).map((r) => r.id);
    const expired = missing
        .filter((r) => r.missing_since && new Date(r.missing_since).getTime() < cutoffMs)
        .map((r) => r.id);

    const BATCH = 50;

    for (let i = 0; i < reappeared.length; i += BATCH) {
        await supabase.from('shortcuts')
            .update({ missing_since: null })
            .in('id', reappeared.slice(i, i + BATCH));
    }

    const now = new Date().toISOString();
    for (let i = 0; i < newlyMissing.length; i += BATCH) {
        await supabase.from('shortcuts')
            .update({ missing_since: now })
            .in('id', newlyMissing.slice(i, i + BATCH));
    }

    for (let i = 0; i < expired.length; i += BATCH) {
        await supabase.from('shortcuts').delete().in('id', expired.slice(i, i + BATCH));
    }

    if (reappeared.length > 0) log(`  ♻️  ${reappeared.length} missing shortcuts reappeared in Drive — cleared`);
    if (newlyMissing.length > 0) log(`  ⏳ ${newlyMissing.length} shortcuts not seen in Drive — will delete if still missing after ${SHORTCUT_GRACE_DAYS} days`);

    return expired.length;
}

// ---------------------------------------------------------------------------
// Step 2: Download & upload thumbnails (incremental — skips existing)
// ---------------------------------------------------------------------------
async function processThumbnails(
    accessToken: string,
    files: DriveFile[]
): Promise<{ urlMap: Map<string, string>; failed: number }> {
    log('🖼️  Processing thumbnails...');

    const supabase = getSupabase();
    const urlMap = new Map<string, string>();

    // Check the STORAGE BUCKET for existing thumbnails (not just the DB column).
    // This catches thumbnails that were uploaded but whose URLs weren't written to DB.
    const existingInStorage = new Set<string>();
    const customThumbnailIds = new Set<string>(); // Track assets with user-set custom thumbnails
    log('  Scanning storage bucket for existing thumbnails...');
    let listOffset = 0;
    const LIST_PAGE = 1000;
    while (true) {
        const { data: storageFiles, error: listErr } = await supabase.storage
            .from('thumbnails')
            .list('', { limit: LIST_PAGE, offset: listOffset, sortBy: { column: 'name', order: 'asc' } });

        if (listErr || !storageFiles || storageFiles.length === 0) break;

        for (const sf of storageFiles) {
            // Files are named {drive_file_id}.webp or custom_{drive_file_id}.webp
            // Custom thumbnails (user-captured video frames) take priority
            if (sf.name.startsWith('custom_')) {
                const driveId = sf.name.replace(/^custom_/, '').replace(/\.webp$/, '');
                if (driveId) {
                    existingInStorage.add(driveId);
                    customThumbnailIds.add(driveId);
                    const { data: urlData } = supabase.storage
                        .from('thumbnails')
                        .getPublicUrl(sf.name);
                    urlMap.set(driveId, urlData.publicUrl);
                }
            } else {
                const driveId = sf.name.replace(/\.webp$/, '');
                if (driveId && !customThumbnailIds.has(driveId)) {
                    existingInStorage.add(driveId);
                    // Build the public URL so upsert can write it to the DB
                    const { data: urlData } = supabase.storage
                        .from('thumbnails')
                        .getPublicUrl(sf.name);
                    urlMap.set(driveId, urlData.publicUrl);
                }
            }
        }

        if (storageFiles.length < LIST_PAGE) break;
        listOffset += LIST_PAGE;
    }
    log(`  Found ${existingInStorage.size} existing thumbnails in storage bucket (${customThumbnailIds.size} custom)`);

    // Filter to only files that need thumbnails
    const needsThumbnail = files.filter(f => f.thumbnailLink && !existingInStorage.has(f.id));
    const noThumbLink = files.filter(f => !f.thumbnailLink).length;
    const skipped = existingInStorage.size;
    log(`  ⏭️  ${skipped} already in storage, ${noThumbLink} have no thumbnail link — processing ${needsThumbnail.length} new`);

    if (needsThumbnail.length === 0) {
        log('  ✅ All thumbnails up to date');
        return { urlMap, failed: 0 };
    }

    // Bounded worker pool with a wall-clock budget. The budget is what keeps
    // a large backlog (bulk upload) from eating the whole job timeout: this
    // step runs before the upsert, so a job killed here used to lose the
    // entire run — no metadata, no orphan detection, no sync log — and repeat
    // that every run until the backlog drained. Files left over are simply
    // picked up next run (this step is incremental).
    const deadline = Date.now() + THUMBNAIL_BUDGET_MS;
    let uploaded = 0;
    let failedDownloads = 0;
    let deferred = 0;
    let done = 0;

    const fetchAndStore = async (file: DriveFile): Promise<'ok' | 'failed' | 'rate-limited'> => {
        try {
            const url = file.thumbnailLink!.replace(/=s\d+$/, '') + `=s${THUMBNAIL_MAX_PX}`;
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (res.status === 429) return 'rate-limited';
            if (!res.ok) return 'failed';

            const webp = await encodeThumbnail(Buffer.from(await res.arrayBuffer()));
            if (!webp) return 'failed';

            const { error } = await supabase.storage
                .from('thumbnails')
                .upload(`${file.id}.webp`, webp, {
                    contentType: 'image/webp',
                    upsert: true,
                });
            if (error) return 'failed';

            const { data } = supabase.storage
                .from('thumbnails')
                .getPublicUrl(`${file.id}.webp`);
            urlMap.set(file.id, data.publicUrl);
            return 'ok';
        } catch {
            return 'failed';
        }
    };

    const queue = [...needsThumbnail];
    const worker = async () => {
        while (queue.length > 0) {
            if (Date.now() > deadline) {
                deferred += queue.length;
                queue.length = 0;
                return;
            }
            const file = queue.shift()!;
            let result = await fetchAndStore(file);
            // Back off and retry rate-limited fetches in place (3 attempts).
            for (let attempt = 1; result === 'rate-limited' && attempt <= 3; attempt++) {
                await sleep(1000 * 2 ** attempt);
                result = await fetchAndStore(file);
            }
            if (result === 'ok') uploaded++;
            else failedDownloads++;

            done++;
            if (done % 25 === 0 || done === needsThumbnail.length) {
                emitProgress('thumbnails', `Uploading thumbnails — ${done}/${needsThumbnail.length}`,
                    Math.round((done / needsThumbnail.length) * 100));
                progress(done, needsThumbnail.length, 'thumbnails');
            }
        }
    };
    await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, worker));

    if (deferred > 0) {
        log(`  ⏱️  Thumbnail budget (${THUMBNAIL_BUDGET_MS / 60000} min) reached — ${deferred} deferred to the next sync`);
    }
    log(`  ✅ Uploaded ${uploaded} new thumbnails (${skipped} already existed${failedDownloads > 0 ? `, ${failedDownloads} failed` : ''})`);
    return { urlMap, failed: failedDownloads };
}

// ---------------------------------------------------------------------------
// Step 3b helper: Self-healing — fix stale googleusercontent.com thumbnail URLs
// ---------------------------------------------------------------------------
async function repairStaleThumbnailUrls(): Promise<number> {
    const supabase = getSupabase();

    // Find all active assets still pointing to temp Google URLs
    const { data: staleAssets, error } = await supabase
        .from('assets')
        .select('id, drive_file_id')
        .eq('is_active', true)
        .like('thumbnail_url', '%googleusercontent.com%');

    if (error || !staleAssets || staleAssets.length === 0) {
        return 0;
    }

    log(`  🔍 Found ${staleAssets.length} assets with stale Google thumbnail URLs`);

    // Update each to the correct Supabase Storage public URL.
    // Prefer custom thumbnails (user-captured video frames) over auto-generated ones.
    let repaired = 0;
    const BATCH = 50;

    for (let i = 0; i < staleAssets.length; i += BATCH) {
        const batch = staleAssets.slice(i, i + BATCH);

        for (const asset of (batch as { id: string; drive_file_id: string }[])) {
            // Check for custom thumbnail first (user-set video frame)
            const customPath = `custom_${asset.drive_file_id}.webp`;
            const standardPath = `${asset.drive_file_id}.webp`;

            // Try custom first — getPublicUrl is a client-side URL builder (no network call)
            // but we need to verify the file exists. Use list with prefix filter.
            const { data: customFiles } = await supabase.storage
                .from('thumbnails')
                .list('', { search: customPath, limit: 1 });

            const filePath = (customFiles && customFiles.length > 0) ? customPath : standardPath;
            const { data: urlData } = supabase.storage
                .from('thumbnails')
                .getPublicUrl(filePath);

            const { error: updateErr } = await supabase.from('assets')
                .update({ thumbnail_url: urlData.publicUrl })
                .eq('id', asset.id);

            if (!updateErr) repaired++;
        }

        progress(Math.min(i + BATCH, staleAssets.length), staleAssets.length, 'thumbnail URLs repaired');
    }

    return repaired;
}

// ---------------------------------------------------------------------------
// Step 3: Upsert to Supabase

// ---------------------------------------------------------------------------
async function upsertToSupabase(
    files: DriveFile[],
    thumbnailUrls: Map<string, string>,
    skipThumbnails: boolean = false
): Promise<{ upserted: number; errors: number }> {
    log('💾 Upserting to Supabase...');

    const supabase = getSupabase();
    const BATCH = 50;
    let upserted = 0;
    let errors = 0;

    // Look up assets that already have a custom thumbnail (user-set video frame).
    // Never overwrite these — they were intentionally set by the user.
    const customThumbnailIds = new Set<string>();
    if (!skipThumbnails) {
        const driveIds = files.map(f => f.id);
        for (let i = 0; i < driveIds.length; i += 150) {
            const batch = driveIds.slice(i, i + 150);
            const { data } = await supabase
                .from('assets')
                .select('drive_file_id')
                .in('drive_file_id', batch)
                .like('thumbnail_url', '%/custom_%');
            if (data) {
                for (const row of (data as { drive_file_id: string }[])) {
                    customThumbnailIds.add(row.drive_file_id);
                }
            }
        }
        if (customThumbnailIds.size > 0) {
            log(`  🔒 Preserving ${customThumbnailIds.size} custom thumbnails (user-set)`);
        }
    }

    for (let i = 0; i < files.length; i += BATCH) {
        const batch = files.slice(i, i + BATCH);
        const rows = batch.map((file) => {
            // Column mapping is shared with the ingest path (src/lib/sync/asset-row).
            const parsed = parseFilename(file.name);
            const row = buildAssetRow({
                ...file,
                creator: null,
                projectDescription: null,
                parsedCreator: parsed.creator,
                parsedShootDate: parsed.shootDate?.toISOString().split('T')[0] ?? null,
                parsedShootDescription: parsed.shootDescription,
            });

            // Only set thumbnail_url to a permanent Supabase Storage URL.
            // Never write temp googleusercontent.com URLs to the DB.
            // Never overwrite custom thumbnails (user-captured video frames).
            // If no Supabase URL exists, omit the field so the upsert
            // preserves whatever is already in the DB.
            if (!skipThumbnails && !customThumbnailIds.has(file.id)) {
                const supabaseThumbUrl = thumbnailUrls.get(file.id);
                if (supabaseThumbUrl) {
                    row.thumbnail_url = supabaseThumbUrl;
                }
            }

            return row;
        });

        const { error } = await supabase
            .from('assets')
            .upsert(rows, { onConflict: 'drive_file_id', ignoreDuplicates: false });

        if (error) {
            log(`  ❌ Batch error (${batch.length} rows): ${error.message}`);
            errors += batch.length; // sync_logs.upsert_errors counts rows, not batches
        } else {
            upserted += batch.length;
        }

        progress(Math.min(i + BATCH, files.length), files.length, 'upserted');
        const done = Math.min(i + BATCH, files.length);
        const pct = Math.round((done / files.length) * 100);
        emitProgress('upsert', `Upserting to database — ${done}/${files.length}`, pct);
    }

    log(`  ✅ Upserted ${upserted} assets (${errors} rows failed)`);
    emitProgress('upsert', `Upserted ${upserted} assets`, 100);
    return { upserted, errors };
}

// ---------------------------------------------------------------------------
// Step 4: Detect orphans — soft-delete assets missing from Drive
// ---------------------------------------------------------------------------
async function detectOrphans(
    crawledIds: Set<string>,
    syncStartedAt: string,
    ignoredFolderPaths: string[] = []
): Promise<{ softDeleted: number; restored: number; massOrphanBlocked: number }> {
    log('🔍 Detecting orphaned assets...');

    const supabase = getSupabase();
    let softDeleted = 0;
    let restored = 0;

    // Fetch all active assets from DB (paginated — Supabase default limit is 1000)
    const activeAssets: { id: string; drive_file_id: string; folder_path: string | null }[] = [];
    let fetchErr: { message: string } | null = null;
    {
        let from = 0;
        const PAGE = 1000;
        while (true) {
            const { data, error } = await supabase
                .from('assets')
                .select('id, drive_file_id, folder_path')
                .eq('is_active', true)
                // Skip rows touched after this sync started: a targeted ingest
                // landing mid-sync isn't in the crawl set and would otherwise
                // be soft-deleted as orphaned until the next sync restores it.
                .lt('updated_at', syncStartedAt)
                .order('id') // stable order — offset paging on an unordered set can skip/repeat rows
                .range(from, from + PAGE - 1);

            if (error) { fetchErr = error; break; }
            if (!data || data.length === 0) break;
            activeAssets.push(...data);
            if (data.length < PAGE) break;
            from += PAGE;
        }
    }

    if (fetchErr) {
        log(`  ❌ Failed to fetch active assets: ${fetchErr.message}`);
        return { softDeleted: 0, restored: 0, massOrphanBlocked: 0 };
    }

    // Find active assets NOT in the Drive crawl set → soft-delete
    const orphanIds: string[] = [];
    const ignoredIds: string[] = [];
    const outOfScopeIds: string[] = [];
    for (const asset of activeAssets || []) {
        if (crawledIds.has(asset.drive_file_id)) continue;

        // Is the asset's folder_path the ignored folder or nested inside it?
        // (Boundary-checked — plain startsWith would also match sibling
        // folders sharing a name prefix.) The explicit [relay-ignore] tag
        // wins over scope classification.
        const isIgnored = ignoredFolderPaths.some(ip =>
            asset.folder_path === ip || asset.folder_path?.startsWith(ip + '/'));
        if (isIgnored) {
            ignoredIds.push(asset.id);
            continue;
        }

        // Absent because the sync_folders allowlist no longer covers its
        // top-level folder: the file still exists in Drive, so tag it
        // out-of-scope — purgeExpired skips these, keeping embeddings and
        // thumbnails intact in case the folder is re-scoped.
        const topFolder = asset.folder_path?.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
        if (SYNC_FOLDERS.length > 0 && !SYNC_FOLDERS.includes(topFolder)) {
            outOfScopeIds.push(asset.id);
        } else {
            orphanIds.push(asset.id);
        }
    }

    // Circuit breaker. Scope is matched by top-level folder *name*, so
    // renaming a synced folder (or a Drive listing that comes back short)
    // makes every file under it look deleted — and 14 days later the purge
    // would hard-delete rows, embeddings and custom thumbnails. Explicit
    // admin actions (ignored / out-of-scope) are not throttled.
    // The fraction is of the whole live library. activeAssets can't be the
    // base: it excludes rows touched since the sync started, i.e. everything
    // the upsert just wrote — it's essentially the orphan candidates alone.
    const librarySize = crawledIds.size + activeAssets.length;
    const orphanLimit = Math.max(MASS_ORPHAN_MIN, Math.floor(librarySize * MASS_ORPHAN_FRACTION));
    let massOrphanBlocked = 0;
    if (orphanIds.length > orphanLimit && !ALLOW_MASS_ORPHAN) {
        massOrphanBlocked = orphanIds.length;
        log(`  🛑 ${orphanIds.length} assets would be trashed as orphaned (limit ${orphanLimit}) — skipping.`);
        log('     Likely a renamed/moved top-level folder or an incomplete Drive listing.');
        log('     If the deletion is real, re-run with --allow-mass-orphan.');
        orphanIds.length = 0;
    }

    const allDeleteIds = [
        ...orphanIds.map(id => ({ id, reason: 'orphaned' as const })),
        ...ignoredIds.map(id => ({ id, reason: 'ignored' as const })),
        ...outOfScopeIds.map(id => ({ id, reason: 'out-of-scope' as const })),
    ];

    if (allDeleteIds.length > 0) {
        // Batch update: set is_active=false, deleted_at=now(), deleted_reason
        const BATCH = 50;
        for (let i = 0; i < allDeleteIds.length; i += BATCH) {
            const batch = allDeleteIds.slice(i, i + BATCH);
            // Group by reason for correct tagging
            for (const reason of ['orphaned', 'ignored', 'out-of-scope'] as const) {
                const ids = batch.filter(b => b.reason === reason).map(b => b.id);
                if (ids.length === 0) continue;
                const { data, error } = await supabase.from('assets')
                    .update({
                        is_active: false,
                        deleted_at: new Date().toISOString(),
                        deleted_reason: reason,
                    })
                    .in('id', ids)
                    // Only live rows: already-trashed ones keep their countdown.
                    // (Keyed on is_active, not deleted_at — see buildAssetRow.)
                    .eq('is_active', true)
                    .select('id');

                if (error) {
                    // e.g. deleted_reason CHECK constraint not yet migrated
                    log(`  ❌ Soft-delete failed for ${ids.length} ${reason} assets: ${error.message}`);
                } else {
                    softDeleted += data?.length ?? 0;
                }
            }
        }
        log(`  🗑️  Soft-deleted ${softDeleted} assets (${orphanIds.length} orphaned, ${ignoredIds.length} in ignored folders, ${outOfScopeIds.length} out of sync scope)`);
    }

    // Check for previously soft-deleted assets that are back in Drive → restore (paginated)
    const deletedAssets: { id: string; drive_file_id: string }[] = [];
    let delErr: { message: string } | null = null;
    {
        let from = 0;
        const PAGE = 1000;
        while (true) {
            const { data, error } = await supabase
                .from('assets')
                .select('id, drive_file_id')
                .eq('is_active', false)
                .not('deleted_at', 'is', null)
                .order('id') // stable order — offset paging on an unordered set can skip/repeat rows
                .range(from, from + PAGE - 1);

            if (error) { delErr = error; break; }
            if (!data || data.length === 0) break;
            deletedAssets.push(...(data as { id: string; drive_file_id: string }[]));
            if (data.length < PAGE) break;
            from += PAGE;
        }
    }

    if (!delErr && deletedAssets.length > 0) {
        const restoreIds: string[] = [];
        for (const asset of deletedAssets) {
            if (crawledIds.has(asset.drive_file_id)) {
                restoreIds.push(asset.id);
            }
        }

        if (restoreIds.length > 0) {
            for (let i = 0; i < restoreIds.length; i += 150) {
                const { data, error } = await supabase.from('assets')
                    .update({
                        is_active: true,
                        deleted_at: null,
                        deleted_reason: null,
                    })
                    .in('id', restoreIds.slice(i, i + 150))
                    .select('id');

                if (error) log(`  ❌ Restore failed: ${error.message}`);
                else restored += data?.length ?? 0;
            }
            log(`  ♻️  Restored ${restored} assets (back in Drive)`);
        }
    }

    if (softDeleted === 0 && restored === 0) {
        log('  ✅ No orphaned assets detected');
    }

    return { softDeleted, restored, massOrphanBlocked };
}

// ---------------------------------------------------------------------------
// Step 5: Purge expired orphans — hard-delete after 14 days
// ---------------------------------------------------------------------------
async function purgeExpired(): Promise<number> {
    log(`🧹 Purging assets deleted more than ${PURGE_AFTER_DAYS} days ago...`);

    const supabase = getSupabase();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PURGE_AFTER_DAYS);

    // Find assets past the grace period (paginated)
    const expired: { id: string; drive_file_id: string; name: string }[] = [];
    {
        let from = 0;
        const PAGE = 1000;
        while (true) {
            const { data, error } = await supabase
                .from('assets')
                .select('id, drive_file_id, name')
                .eq('is_active', false)
                .not('deleted_at', 'is', null)
                .lt('deleted_at', cutoff.toISOString())
                // out-of-scope assets are config-excluded, not gone from
                // Drive — keep their rows (embeddings, thumbnails) so
                // re-scoping the folder restores them for free. NULL reasons
                // are legacy orphans and still purge.
                .or('deleted_reason.neq.out-of-scope,deleted_reason.is.null')
                .order('id') // stable order — offset paging on an unordered set can skip/repeat rows
                .range(from, from + PAGE - 1);

            if (error || !data || data.length === 0) break;
            expired.push(...data);
            if (data.length < PAGE) break;
            from += PAGE;
        }
    }

    if (expired.length === 0) {
        log('  ✅ No expired assets to purge');
        return 0;
    }

    log(`  Found ${expired.length} expired assets — removing rows + thumbnails...`);

    // Rows first, re-checking the trash state in the DELETE itself: a restore
    // or re-ingest landing between the fetch above and here must not lose its
    // row. Thumbnails (including irreplaceable custom video frames) are then
    // removed only for rows that were actually deleted.
    const BATCH = 50;
    const purgedDriveIds: string[] = [];
    for (let i = 0; i < expired.length; i += BATCH) {
        const batch = expired.slice(i, i + BATCH).map((a) => a.id);
        const { data, error } = await supabase.from('assets')
            .delete()
            .in('id', batch)
            .eq('is_active', false)
            .not('deleted_at', 'is', null)
            .lt('deleted_at', cutoff.toISOString())
            .select('drive_file_id');
        if (error) {
            log(`  ❌ Purge delete failed for ${batch.length} rows: ${error.message}`);
            continue;
        }
        purgedDriveIds.push(...(data ?? []).map((r: { drive_file_id: string }) => r.drive_file_id));
    }

    const thumbPaths = purgedDriveIds.flatMap((id) => [`${id}.webp`, `custom_${id}.webp`]);
    for (let i = 0; i < thumbPaths.length; i += BATCH) {
        const { error } = await supabase.storage.from('thumbnails').remove(thumbPaths.slice(i, i + BATCH));
        if (error) log(`  ⚠️  Thumbnail removal failed: ${error.message}`);
    }

    log(`  🗑️  Purged ${purgedDriveIds.length} assets (rows + thumbnails)`);
    return purgedDriveIds.length;
}

// ---------------------------------------------------------------------------
// Step 6: Re-embed assets whose metadata changed
// ---------------------------------------------------------------------------
interface MetadataSnapshot {
    name: string;
    description: string | null;
    parsed_shoot_description: string | null;
}

async function snapshotMetadata(): Promise<Map<string, MetadataSnapshot>> {
    const supabase = getSupabase();
    const map = new Map<string, MetadataSnapshot>();

    // Paginate through all active assets
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const { data, error } = await supabase
            .from('assets')
            .select('drive_file_id, name, description, parsed_shoot_description')
            .eq('is_active', true)
            .order('id') // stable order — offset paging on an unordered set can skip/repeat rows
            .range(from, from + PAGE - 1);

        if (error || !data || data.length === 0) break;
        for (const row of (data as { drive_file_id: string; name: string; description: string | null; parsed_shoot_description: string | null }[])) {
            map.set(row.drive_file_id, {
                name: row.name,
                description: row.description,
                parsed_shoot_description: row.parsed_shoot_description,
            });
        }
        if (data.length < PAGE) break;
        from += PAGE;
    }

    return map;
}

// Embedding text comes from the shared builder (src/lib/embedding-text) so
// sync.ts and embed.ts produce identical document text for the same asset.

// Build the multimodal content parts (text + optional thumbnail image).
// Thumbnails are stored as .webp but hold JPEG/PNG bytes; Gemini only accepts
// image/jpeg and image/png, so the real format is sniffed from magic bytes.
type EmbeddableAsset = EmbeddableAssetRow & {
    id: string;
    drive_file_id: string;
    thumbnail_url: string | null;
};
type GeminiPart =
    | { text: string }
    | { inline_data: { mime_type: string; data: string } };

async function buildEmbedParts(asset: EmbeddableAsset): Promise<{ parts: GeminiPart[]; hasImage: boolean }> {
    const parts: GeminiPart[] = [{ text: buildEmbedText(asset) }];

    if (asset.thumbnail_url && !asset.thumbnail_url.includes('googleusercontent.com') && asset.drive_file_id) {
        const supabase = getSupabase();
        for (const thumbPath of [`custom_${asset.drive_file_id}.webp`, `${asset.drive_file_id}.webp`]) {
            try {
                const { data: thumbData, error: thumbErr } = await supabase.storage
                    .from('thumbnails')
                    .download(thumbPath);
                if (!thumbErr && thumbData) {
                    const buffer = Buffer.from(await thumbData.arrayBuffer());
                    const hex = buffer.slice(0, 4).toString('hex');
                    const mimeType = hex.startsWith('ffd8') ? 'image/jpeg'
                        : hex.startsWith('8950') ? 'image/png'
                        : 'image/jpeg';
                    parts.push({ inline_data: { mime_type: mimeType, data: buffer.toString('base64') } });
                    return { parts, hasImage: true };
                }
            } catch {
                // Fall through to text-only
            }
        }
    }

    return { parts, hasImage: false };
}

async function reEmbedChanged(
    files: DriveFile[],
    beforeSnapshot: Map<string, MetadataSnapshot>
): Promise<number> {
    if (!GEMINI_API_KEY) {
        log('⏭️  No GEMINI_API_KEY — skipping re-embedding');
        return 0;
    }

    log('🔄 Checking for metadata changes that need re-embedding...');

    const supabase = getSupabase();
    const changedDriveIds: string[] = [];

    for (const file of files) {
        const before = beforeSnapshot.get(file.id);
        // New assets won't have a before snapshot — they'll have embedding=null
        // and will be picked up by the backfill query below
        if (!before) continue;

        const parsed = parseFilename(file.name);
        const newDesc = parsed.shootDescription ?? null;
        const fileDesc = file.description ?? null;

        if (
            before.name !== file.name ||
            before.description !== fileDesc ||
            before.parsed_shoot_description !== newDesc
        ) {
            changedDriveIds.push(file.id);
        }
    }

    // Null out embeddings for changed assets so they get re-embedded below
    if (changedDriveIds.length > 0) {
        log(`  Found ${changedDriveIds.length} assets with changed metadata — nulling embeddings...`);
        const NULL_BATCH = 50;
        for (let i = 0; i < changedDriveIds.length; i += NULL_BATCH) {
            const batch = changedDriveIds.slice(i, i + NULL_BATCH);
            await supabase.from('assets')
                .update({ embedding: null })
                .in('drive_file_id', batch);
        }
    } else {
        log('  ✅ No metadata changes detected');
    }

    // ── Backfill: fetch ALL assets with null embeddings (paginated) ──
    log('  🧠 Fetching all assets that need embeddings...');
    const toEmbed: EmbeddableAsset[] = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
        const { data, error } = await supabase
            .from('assets')
            .select('id, drive_file_id, name, description, asset_type, folder_path, parsed_creator, parsed_shoot_description, thumbnail_url')
            .is('embedding', null)
            .eq('is_active', true)
            .order('id') // stable order — offset paging on an unordered set can skip/repeat rows
            .range(from, from + PAGE - 1);

        if (error) {
            log(`  ❌ Failed to fetch null-embedding assets: ${error.message}`);
            break;
        }
        if (!data || data.length === 0) break;
        toEmbed.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }

    if (toEmbed.length === 0) {
        log('  ✅ All embeddings are up to date');
        return 0;
    }

    log(`  📊 ${toEmbed.length} assets need embeddings (${changedDriveIds.length} changed, ${toEmbed.length - changedDriveIds.length} new/missing)`);

    // ── Embed in batches of 20 with retry (multimodal — text + thumbnail) ──
    const EMBED_BATCH = 20;
    let embedded = 0;
    let failed = 0;
    let withImage = 0;
    const MAX_RETRIES = 2;

    for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
        const batch = toEmbed.slice(i, i + EMBED_BATCH);

        // Build multimodal requests: text + thumbnail for each asset
        const requests = await Promise.all(
            batch.map(async (asset) => {
                const { parts, hasImage } = await buildEmbedParts(asset);
                if (hasImage) withImage++;
                return {
                    model: 'models/gemini-embedding-2-preview',
                    content: { parts },
                    outputDimensionality: 768,
                };
            })
        );

        // Retry loop for Gemini API calls
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const res = await fetch(GEMINI_EMBED_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
                    body: JSON.stringify({ requests }),
                });

                if (!res.ok) {
                    const errText = await res.text();
                    if (res.status === 429 && attempt < MAX_RETRIES) {
                        const backoff = (attempt + 1) * 3000;
                        log(`  ⚠️  Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoff / 1000}s...`);
                        await sleep(backoff);
                        continue;
                    }
                    log(`  ❌ Gemini API error: ${res.status} ${errText.slice(0, 200)} (batch ${Math.floor(i / EMBED_BATCH) + 1})`);
                    failed += batch.length;
                    break;
                }

                const data = await res.json();
                const embeddings = (data.embeddings as { values: number[] }[]).map((e) => e.values);

                // Update assets with embeddings — track individual failures
                const UPDATE_CONCURRENCY = 10;
                for (let j = 0; j < batch.length; j += UPDATE_CONCURRENCY) {
                    const updateBatch = batch.slice(j, j + UPDATE_CONCURRENCY);
                    const results = await Promise.allSettled(
                        updateBatch.map((asset, idx) =>
                            supabase.from('assets')
                                .update({ embedding: JSON.stringify(embeddings[j + idx]) })
                                .eq('id', asset.id)
                                .then(({ error }) => {
                                    if (error) throw error;
                                })
                        )
                    );
                    const succeeded = results.filter(r => r.status === 'fulfilled').length;
                    const dbFailed = results.filter(r => r.status === 'rejected').length;
                    embedded += succeeded;
                    if (dbFailed > 0) {
                        failed += dbFailed;
                        log(`  ⚠️  ${dbFailed} DB writes failed in update batch`);
                    }
                }
                break; // Success — exit retry loop
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    const backoff = (attempt + 1) * 2000;
                    log(`  ⚠️  Embedding error (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${message}, retrying in ${backoff / 1000}s...`);
                    await sleep(backoff);
                } else {
                    // Batch failed after all retries — retry each asset individually
                    log(`  ⚠️  Batch ${Math.floor(i / EMBED_BATCH) + 1} failed after ${MAX_RETRIES + 1} attempts, retrying individually...`);
                    for (const asset of batch) {
                        try {
                            // Try multimodal first
                            const { parts, hasImage } = await buildEmbedParts(asset);
                            const singleReq = [{ model: 'models/gemini-embedding-2-preview', content: { parts }, outputDimensionality: 768 }];
                            const singleRes = await fetch(GEMINI_EMBED_URL, {
                                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
                                body: JSON.stringify({ requests: singleReq }),
                            });

                            if (!singleRes.ok) throw new Error(`API ${singleRes.status}`);
                            const singleData = await singleRes.json();
                            const vec = singleData.embeddings[0].values;

                            const { error: ue } = await supabase.from('assets')
                                .update({ embedding: JSON.stringify(vec) }).eq('id', asset.id);
                            if (!ue) { embedded++; if (hasImage) withImage++; }
                            else failed++;
                        } catch {
                            // Multimodal failed — try text-only
                            try {
                                const textReq = [{ model: 'models/gemini-embedding-2-preview', content: { parts: [{ text: buildEmbedText(asset) }] }, outputDimensionality: 768 }];
                                const textRes = await fetch(GEMINI_EMBED_URL, {
                                    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
                                    body: JSON.stringify({ requests: textReq }),
                                });
                                if (!textRes.ok) throw new Error(`API ${textRes.status}`);
                                const textData = await textRes.json();
                                const vec = textData.embeddings[0].values;

                                const { error: ue } = await supabase.from('assets')
                                    .update({ embedding: JSON.stringify(vec) }).eq('id', asset.id);
                                if (!ue) { embedded++; log(`    ↳ ${asset.name}: text-only fallback ✓`); }
                                else failed++;
                            } catch (e2) {
                                failed++;
                                log(`    ↳ ${asset.name}: failed entirely — ${e2 instanceof Error ? e2.message : String(e2)}`);
                            }
                        }
                        await sleep(200);
                    }
                }
            }
        }

        const done = Math.min(i + EMBED_BATCH, toEmbed.length);
        progress(done, toEmbed.length, 'embedded');
        const pct = Math.round((done / toEmbed.length) * 100);
        emitProgress('reembed', `Embedding — ${done}/${toEmbed.length} (${embedded} succeeded, ${withImage} multimodal)`, pct);

        if (i + EMBED_BATCH < toEmbed.length) await sleep(500);
    }

    log(`  ✅ Embedded ${embedded} assets${failed > 0 ? ` (${failed} failed)` : ''}`);
    return embedded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    // Parse CLI flags
    const args = process.argv.slice(2);
    const skipThumbnails = args.includes('--skip-thumbnails');

    if (!PROGRESS_STREAM) {
        console.log('');
        console.log('╔══════════════════════════════════════════╗');
        console.log('║   Relay Asset Manager — Drive Sync       ║');
        console.log('╚══════════════════════════════════════════╝');
        console.log('');
    }
    if (skipThumbnails) log('⏭️  Skipping thumbnail processing (--skip-thumbnails)');

    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    runStartedAt = startedAt;
    emitProgress('start', 'Starting sync...');

    // Validate config
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new Error('Missing Supabase config in .env.local — NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }

    // Load centralized settings from DB (overrides env vars when available)
    log('⚙️  Loading configuration...');
    await loadConfig();
    log(`  Drive ID: ${DRIVE_ID}`);
    log(`  Sync folders: ${SYNC_FOLDERS.length > 0 ? SYNC_FOLDERS.join(', ') : '(all)'}`);
    log(`  Label ID: ${RIGHTS_LABEL_ID}`);

    if (!DRIVE_ID) throw new Error('Missing GOOGLE_SHARED_DRIVE_ID — set in app_settings or .env.local');
    // CLIENT_ID/SECRET only needed for non-WIF auth paths (local dev without service account)
    const hasWifOrAdc = !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (!hasWifOrAdc && (!CLIENT_ID || !CLIENT_SECRET)) {
        throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (not needed if using WIF/ADC)');
    }
    if (!GEMINI_API_KEY) log('⚠️  No GEMINI_API_KEY — re-embedding of changed assets will be skipped');

    // Step 0: Auth
    emitProgress('auth', 'Authenticating with Google...');
    const accessToken = await getAccessToken();
    emitProgress('auth', 'Authenticated', 100);

    // Step 0.5: Snapshot metadata before upsert (for change detection)
    const metadataBefore = await snapshotMetadata();

    // Step 0.75: Pre-fetch entire folder hierarchy (eliminates hundreds of individual API calls)
    const folderTree = await prefetchFolderTree(accessToken);

    // Step 1: Crawl
    emitProgress('crawl', 'Crawling Google Drive...');
    const { files, folderIdMap, stats: crawlStats } = await crawlDrive(accessToken, folderTree);

    if (files.length === 0) {
        log('No assets found — nothing to sync.');
        emitProgress('done', 'No assets found', 100);
        return;
    }

    // Persist folder path → Drive folder ID mapping for "Open in Google Drive" links
    if (Object.keys(folderIdMap).length > 0) {
        const supabase = getSupabase();
        await supabase.from('app_settings').upsert({
            key: 'folder_drive_ids',
            value: folderIdMap,
            updated_at: new Date().toISOString(),
        });
        log(`  📁 Saved ${Object.keys(folderIdMap).length} folder-to-Drive-ID mappings`);
    }

    // Step 2: Thumbnails (optional)
    let thumbnailUrls: Map<string, string>;
    let thumbnailsUploaded = 0;
    let thumbnailErrors = 0;
    if (skipThumbnails) {
        log('⏭️  Thumbnail step skipped — using existing URLs from database');
        thumbnailUrls = new Map<string, string>();
        emitProgress('thumbnails', 'Skipped', 100);
    } else {
        emitProgress('thumbnails', 'Processing thumbnails...');
        const thumbs = await processThumbnails(accessToken, files);
        thumbnailUrls = thumbs.urlMap;
        thumbnailsUploaded = thumbnailUrls.size;
        // Counted directly: the URL map also holds every pre-existing storage
        // object, so deriving failures from its size undercounted them.
        thumbnailErrors = thumbs.failed;
        emitProgress('thumbnails', `Uploaded ${thumbnailsUploaded} thumbnails`, 100);
    }

    // Step 3: Upsert
    emitProgress('upsert', 'Upserting to database...');
    const { upserted, errors: upsertErrors } = await upsertToSupabase(files, thumbnailUrls, skipThumbnails);

    // Step 3b: Self-healing — fix any stale Google thumbnail URLs remaining in DB
    let thumbnailsRepaired = 0;
    if (!skipThumbnails) {
        emitProgress('thumbnail-repair', 'Checking for stale thumbnail URLs...');
        thumbnailsRepaired = await repairStaleThumbnailUrls();
        if (thumbnailsRepaired > 0) {
            log(`  🔧 Repaired ${thumbnailsRepaired} stale thumbnail URLs`);
        }
        emitProgress('thumbnail-repair', `${thumbnailsRepaired} repaired`, 100);
    }

    // Step 4: Detect orphans (soft-delete missing, restore returning)
    emitProgress('orphans', 'Detecting orphaned assets...');
    const crawledIds = new Set(files.map((f) => f.id));
    const ignoredPaths = crawlStats.ignoredFolders.map(f => f.path);
    const { softDeleted, restored, massOrphanBlocked } = await detectOrphans(crawledIds, startedAt, ignoredPaths);
    emitProgress('orphans', `${softDeleted} soft-deleted, ${restored} restored`, 100);

    // Step 5: Resolve shortcuts — discover and link shortcuts to assets
    emitProgress('shortcuts', 'Resolving shortcuts...');
    const shortcutResult = await resolveShortcuts(accessToken, files, folderTree);

    // Step 6: Purge expired orphans (hard-delete after 14 days)
    emitProgress('purge', 'Purging expired assets...');
    const purged = await purgeExpired();
    emitProgress('purge', `${purged} purged`, 100);

    // Step 7: Re-embed assets with changed metadata
    emitProgress('reembed', 'Checking for metadata changes...');
    const reEmbedded = await reEmbedChanged(files, metadataBefore);
    emitProgress('reembed', `${reEmbedded} re-embedded`, 100);

    // Done!
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const durationSecs = (Date.now() - startTime) / 1000;
    const finishedAt = new Date().toISOString();

    if (!PROGRESS_STREAM) {
        console.log('');
    }
    log(`🎉 Sync complete! ${files.length} assets in ${elapsed}s`);
    if (softDeleted > 0) log(`   🗑️  ${softDeleted} soft-deleted (14-day grace period)`);
    if (restored > 0) log(`   ♻️  ${restored} restored`);
    if (shortcutResult.matched > 0) log(`   🔗 ${shortcutResult.matched} shortcuts linked`);
    if (shortcutResult.orphansRemoved > 0) log(`   🗑️  ${shortcutResult.orphansRemoved} orphaned shortcuts removed`);
    if (purged > 0) log(`   🧹 ${purged} purged (past ${PURGE_AFTER_DAYS}-day grace period)`);
    if (thumbnailsRepaired > 0) log(`   🔧 ${thumbnailsRepaired} stale thumbnail URLs repaired`);
    if (reEmbedded > 0) log(`   🧠 ${reEmbedded} re-embedded`);
    if (!PROGRESS_STREAM) {
        console.log('');
    }

    // Write sync log to Supabase
    try {
        const supabase = getSupabase();
        const hasErrors = upsertErrors > 0 || thumbnailErrors > 0 || massOrphanBlocked > 0;
        await supabase.from('sync_logs').insert({
            started_at: startedAt,
            finished_at: finishedAt,
            duration_secs: durationSecs,
            assets_found: files.length,
            assets_upserted: upserted,
            upsert_errors: upsertErrors,
            thumbnails_uploaded: thumbnailsUploaded,
            thumbnail_errors: thumbnailErrors,
            soft_deleted: softDeleted,
            restored,
            purged,
            re_embedded: reEmbedded,
            skipped_by_folder: crawlStats.skippedByFolder,
            skipped_by_ignore: crawlStats.skippedByIgnore,
            ignored_folders: crawlStats.ignoredFolders,
            shortcuts_resolved: shortcutResult.matched,
            shortcuts_failed: shortcutResult.failed,
            shortcuts_orphaned: shortcutResult.orphansRemoved,
            master_folders: SYNC_FOLDERS,
            status: hasErrors ? 'partial' : 'success',
            error_message: massOrphanBlocked > 0
                ? `Skipped trashing ${massOrphanBlocked} assets missing from Drive (mass-orphan safety limit). `
                  + 'A synced top-level folder may have been renamed or moved. If the files were really deleted, '
                  + 'run the GitHub Actions sync manually with "allow_mass_orphan" checked (CLI: --allow-mass-orphan).'
                : null,
        });
        log('📝 Sync log written to database');
    } catch (err) {
        log(`⚠️  Failed to write sync log: ${err instanceof Error ? err.message : String(err)}`);
    }

    emitProgress('done', `Sync complete! ${files.length} assets in ${elapsed}s`, 100);
}

let runStartedAt: string | null = null;

main().catch(async (err) => {
    console.error('');
    console.error('❌ Sync failed:', err.message);
    // Record the failure so it shows in Settings — otherwise a crashed run
    // leaves no trace in the app and the last success looks current.
    if (runStartedAt && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        try {
            const finishedAt = new Date();
            await getSupabase().from('sync_logs').insert({
                started_at: runStartedAt,
                finished_at: finishedAt.toISOString(),
                duration_secs: (finishedAt.getTime() - new Date(runStartedAt).getTime()) / 1000,
                status: 'failed',
                error_message: String(err?.message ?? err).slice(0, 1000),
            });
        } catch { /* best effort */ }
    }
    process.exit(1);
});
