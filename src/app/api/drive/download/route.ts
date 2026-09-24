import { NextRequest, NextResponse } from 'next/server';
import { makeZip } from 'client-zip';
import { createClient } from '@/lib/supabase/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { logger } from '@/lib/logger';
import {
    MAX_ZIP_BYTES,
    MAX_ZIP_FILES,
    createEntryNamer,
    formatBytes,
    type DownloadPreflightResponse,
    type DownloadRequestFile,
    type SkippedDownloadFile,
} from '@/lib/download/shared';
import {
    checkDriveFile,
    logStreamFailure,
    mapWithConcurrency,
    zipEntries,
    type DriveCheck,
} from '@/lib/download/drive-zip';

export const runtime = 'nodejs';
// A zip streams for as long as Drive keeps sending bytes. 300s is the
// ceiling every Vercel plan accepts with fluid compute; MAX_ZIP_BYTES /
// MAX_ZIP_FILES keep requests inside it.
export const maxDuration = 300;

/** Ids per `.in()` query — keeps the PostgREST URL well under proxy limits. */
const SCOPE_QUERY_CHUNK = 100;
/** Parallel Drive metadata lookups during preflight. */
const PREFLIGHT_CONCURRENCY = 8;

const OUT_OF_SCOPE_REASON = 'Not in the library (removed or outside the synced folders)';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * POST /api/drive/download
 *
 * Body: { files: { driveFileId, name }[], mode?: 'zip' | 'preflight' }
 * sent as JSON, or form-encoded as a single `payload` field holding that
 * JSON (the download queue submits a hidden form so the browser streams the
 * zip straight to disk instead of buffering it in a Blob).
 *
 * - mode 'preflight': JSON report of which files can be downloaded and why
 *   the others can't (scope check + Drive metadata). Nothing is streamed.
 * - mode 'zip' (default), 2+ files: streaming zip (client-zip — data
 *   descriptors, UTF-8 names, ZIP64 when needed). Each Drive file is piped
 *   through without buffering. Files that are out of scope or fail in Drive
 *   are listed in a `_relay-download-report.txt` entry so the archive never
 *   silently drops anything.
 * - mode 'zip', 1 file: 303 redirect to the streaming GET endpoint.
 *
 * Uses a service account (via WIF) for Drive access.
 */
export async function POST(request: NextRequest) {
    try {
        const contentType = request.headers.get('content-type') ?? '';
        const isForm = contentType.includes('application/x-www-form-urlencoded')
            || contentType.includes('multipart/form-data');

        // Form posts are "simple" cross-site requests. The Supabase session
        // cookie is SameSite=Lax so a cross-site post is unauthenticated
        // anyway; this is defense in depth for browsers that send the header.
        const fetchSite = request.headers.get('sec-fetch-site');
        if (isForm && fetchSite && fetchSite !== 'same-origin') {
            return NextResponse.json({ error: 'Cross-site download requests are not allowed' }, { status: 403 });
        }

        const body = await parseBody(request, isForm);
        if (!body) {
            return NextResponse.json({ error: 'Invalid download request' }, { status: 400 });
        }
        const { files, mode } = body;

        if (files.length === 0) {
            return NextResponse.json({ error: 'No files specified' }, { status: 400 });
        }
        if (files.length > MAX_ZIP_FILES) {
            return NextResponse.json(
                { error: `Too many files (${files.length}) — downloads are limited to ${MAX_ZIP_FILES} files at a time.` },
                { status: 413 }
            );
        }

        // Verify user is authenticated
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
            return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
        }

        // Single file — redirect to the streaming GET endpoint (which runs its
        // own scope check). 303 so the follow-up request is a GET; the old 307
        // replayed the POST against a GET-only route.
        if (files.length === 1 && mode === 'zip') {
            const file = files[0];
            const url = new URL(
                `/api/drive/download/${encodeURIComponent(file.driveFileId)}`,
                request.nextUrl.origin
            );
            url.searchParams.set('name', file.name);
            return NextResponse.redirect(url, 303);
        }

        // Authorization: restrict downloads to in-scope library files. The
        // service account can read the entire shared drive, so filter the
        // request down to files that actually exist as active assets
        // (confused-deputy / IDOR). Applies to preflight and zip alike — the
        // preflight is advisory, the zip re-checks.
        const inScope = await findInScopeIds(supabase, files.map((f) => f.driveFileId));
        const allowedFiles = files.filter((f) => inScope.has(f.driveFileId));
        const outOfScope: SkippedDownloadFile[] = files
            .filter((f) => !inScope.has(f.driveFileId))
            .map((f) => ({ ...f, reason: OUT_OF_SCOPE_REASON }));

        if (mode === 'preflight') {
            return await preflight(files, allowedFiles, inScope, request.signal);
        }

        if (allowedFiles.length === 0) {
            return NextResponse.json({ error: 'No in-scope files to download' }, { status: 400 });
        }

        // Get Drive access token via WIF service account
        const accessToken = await getDriveAccessToken();

        const nameFor = createEntryNamer();
        const entries = allowedFiles.map((file) => ({ file, entryName: nameFor(file.name) }));
        const skipped = [...outOfScope];
        // Aborted by the request going away *or* by the response stream being
        // cancelled (see logStreamFailure) — whichever the runtime reports.
        const streamAbort = new AbortController();
        const signal = AbortSignal.any([request.signal, streamAbort.signal]);
        const zip = makeZip(
            zipEntries(entries, skipped, files.length, accessToken, nameFor, signal)
        );

        // Timestamp the zip so browsers don't block successive downloads as duplicates
        const now = new Date();
        const ts = now.getFullYear().toString()
            + String(now.getMonth() + 1).padStart(2, '0')
            + String(now.getDate()).padStart(2, '0')
            + '-'
            + String(now.getHours()).padStart(2, '0')
            + String(now.getMinutes()).padStart(2, '0')
            + String(now.getSeconds()).padStart(2, '0');

        const headers = new Headers();
        headers.set('Content-Type', 'application/zip');
        headers.set('Content-Disposition', `attachment; filename="relay-assets-${ts}.zip"`);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        // No Content-Length — we're streaming and don't know total size upfront

        return new NextResponse(logStreamFailure(zip, entries.length, () => streamAbort.abort()), { status: 200, headers });
    } catch (err) {
        logger.error('download-zip', 'Download error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to download files' }, { status: 500 });
    }
}

// -----------------------------------------------------------------------
// Request parsing + scope
// -----------------------------------------------------------------------

async function parseBody(
    request: NextRequest,
    isForm: boolean
): Promise<{ files: DownloadRequestFile[]; mode: 'zip' | 'preflight' } | null> {
    let raw: unknown;
    try {
        if (isForm) {
            const payload = (await request.formData()).get('payload');
            if (typeof payload !== 'string') return null;
            raw = JSON.parse(payload);
        } else {
            raw = await request.json();
        }
    } catch {
        return null;
    }

    const { files, mode } = (raw ?? {}) as { files?: unknown; mode?: unknown };
    if (!Array.isArray(files)) return null;
    if (mode !== undefined && mode !== 'zip' && mode !== 'preflight') return null;

    const parsed: DownloadRequestFile[] = [];
    for (const f of files) {
        const { driveFileId, name } = (f ?? {}) as { driveFileId?: unknown; name?: unknown };
        if (typeof driveFileId !== 'string' || driveFileId.length === 0 || driveFileId.length > 256) return null;
        parsed.push({ driveFileId, name: typeof name === 'string' && name ? name : driveFileId });
    }
    return { files: parsed, mode: mode ?? 'zip' };
}

/** Same filter as before (`drive_file_id in (...) and is_active`), chunked. */
async function findInScopeIds(supabase: SupabaseServerClient, ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    const inScope = new Set<string>();
    for (let i = 0; i < unique.length; i += SCOPE_QUERY_CHUNK) {
        const { data, error } = await supabase
            .from('assets')
            .select('drive_file_id')
            .in('drive_file_id', unique.slice(i, i + SCOPE_QUERY_CHUNK))
            .eq('is_active', true);
        // Fail closed, but loudly: an error used to read as "nothing in scope"
        if (error) throw new Error(`Scope check failed: ${error.message}`);
        for (const row of data ?? []) inScope.add(row.drive_file_id);
    }
    return inScope;
}

// -----------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------

async function preflight(
    files: DownloadRequestFile[],
    allowedFiles: DownloadRequestFile[],
    inScope: Set<string>,
    signal: AbortSignal
): Promise<NextResponse> {
    const checks = new Map<string, DriveCheck>();
    if (allowedFiles.length > 0) {
        const accessToken = await getDriveAccessToken();
        const uniqueIds = [...new Set(allowedFiles.map((f) => f.driveFileId))];
        const results = await mapWithConcurrency(uniqueIds, PREFLIGHT_CONCURRENCY,
            (id) => checkDriveFile(id, accessToken, signal));
        uniqueIds.forEach((id, i) => checks.set(id, results[i]));
    }

    // Walk the original request so `ready` / `skipped` keep the user's order
    const ready: DownloadRequestFile[] = [];
    const skipped: SkippedDownloadFile[] = [];
    let totalBytes = 0;
    for (const file of files) {
        if (!inScope.has(file.driveFileId)) {
            skipped.push({ ...file, reason: OUT_OF_SCOPE_REASON });
            continue;
        }
        const check = checks.get(file.driveFileId)!;
        if (check.ok) {
            ready.push(file);
            totalBytes += check.size;
        } else {
            skipped.push({ ...file, reason: check.reason });
        }
    }

    if (skipped.length > 0) {
        logger.warn('download-preflight', `${skipped.length} of ${files.length} files not downloadable`, {
            reasons: [...new Set(skipped.map((s) => s.reason))],
        });
    }

    // Everything streams through a function limited to maxDuration, so a
    // single huge file (e.g. a multi-GB video) would be cut off mid-download
    // just like an oversized zip — send it to Google Drive instead.
    if (ready.length === 1 && totalBytes > MAX_ZIP_BYTES) {
        return NextResponse.json(
            { error: `This file is ${formatBytes(totalBytes)} — downloads through Relay are limited to ${formatBytes(MAX_ZIP_BYTES)}. Use "Open in Google Drive" to download it.` },
            { status: 413 }
        );
    }
    if (ready.length > 1 && totalBytes > MAX_ZIP_BYTES) {
        return NextResponse.json(
            { error: `Selection is ${formatBytes(totalBytes)} — zip downloads are limited to ${formatBytes(MAX_ZIP_BYTES)}. Select fewer files or download from Google Drive.` },
            { status: 413 }
        );
    }

    const response: DownloadPreflightResponse = { ready, skipped, totalBytes };
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
}
