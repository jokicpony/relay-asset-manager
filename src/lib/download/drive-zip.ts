import { logger } from '@/lib/logger';
import {
    MAX_ZIP_BYTES,
    ZIP_REPORT_NAME,
    formatBytes,
    type DownloadRequestFile,
    type SkippedDownloadFile,
} from '@/lib/download/shared';

/**
 * Server-side download helpers for /api/drive/download: Drive metadata
 * checks for the preflight, and the lazy entry source fed to client-zip.
 */

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
/** Drive downloads in flight while zipping (current file + prefetched ones). */
const ZIP_LOOKAHEAD = 3;

// -----------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------

export type DriveCheck = { ok: true; size: number } | { ok: false; reason: string };

export async function checkDriveFile(fileId: string, accessToken: string, signal: AbortSignal): Promise<DriveCheck> {
    try {
        const res = await fetch(
            `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?fields=mimeType,size,trashed&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${accessToken}` }, signal }
        );
        if (!res.ok) return { ok: false, reason: driveErrorReason(res.status) };
        const meta = await res.json() as { mimeType?: string; size?: string; trashed?: boolean };
        if (meta.trashed) return { ok: false, reason: 'In the Google Drive trash' };
        // Docs/Sheets/etc. have no binary content — alt=media rejects them
        if (meta.mimeType?.startsWith('application/vnd.google-apps.')) {
            return { ok: false, reason: 'Google Workspace file — open it in Drive' };
        }
        return { ok: true, size: Number(meta.size) || 0 };
    } catch (err) {
        logger.warn('download-preflight', 'Drive metadata lookup failed', { fileId, error: String(err) });
        return { ok: false, reason: 'Could not reach Google Drive' };
    }
}

export function driveErrorReason(status: number): string {
    if (status === 404) return 'No longer in Google Drive';
    if (status === 403) return 'Google Drive refused access (403)';
    if (status === 429) return 'Google Drive rate limit — try again shortly';
    return `Google Drive error (${status})`;
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// -----------------------------------------------------------------------
// Zip streaming
// -----------------------------------------------------------------------

/**
 * Lazily yields one zip entry per Drive file for client-zip. Drive responses
 * are passed through as streams — nothing is buffered beyond the socket's
 * own backpressure window. A small lookahead overlaps Drive's time-to-first-
 * byte with the previous file's transfer.
 *
 * A file whose Drive request fails before any bytes are written is skipped
 * and recorded; the list of skipped files becomes a report entry at the end.
 * A failure *mid-file* can't be skipped (its header is already on the wire),
 * so client-zip errors the whole stream and the browser marks the download
 * failed — never a silently truncated archive.
 */
export async function* zipEntries(
    entries: { file: DownloadRequestFile; entryName: string }[],
    skipped: SkippedDownloadFile[],
    requestedCount: number,
    accessToken: string,
    nameFor: (name: string) => string,
    signal: AbortSignal
) {
    const pending: Promise<Response | Error>[] = [];
    let started = 0;
    const fill = () => {
        while (pending.length < ZIP_LOOKAHEAD && started < entries.length) {
            const id = entries[started++].file.driveFileId;
            pending.push(
                fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                    signal,
                }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
            );
        }
    };

    let bytesQueued = 0;
    try {
        for (const { file, entryName } of entries) {
            fill();
            const res = await pending.shift()!;

            if (res instanceof Error) {
                logger.warn('download-zip', `Skipping ${file.name}: ${res.message}`);
                skipped.push({ ...file, reason: 'Could not reach Google Drive' });
                continue;
            }
            if (!res.ok) {
                discard(res);
                logger.warn('download-zip', `Skipping ${file.name}: Drive ${res.status}`);
                skipped.push({ ...file, reason: driveErrorReason(res.status) });
                continue;
            }

            // Preflight enforces the cap on Drive-reported sizes; this guards
            // callers that skip preflight (or files that grew since).
            const size = Number(res.headers.get('content-length')) || 0;
            if (bytesQueued + size > MAX_ZIP_BYTES) {
                discard(res);
                skipped.push({ ...file, reason: `Zip size limit (${formatBytes(MAX_ZIP_BYTES)}) reached` });
                continue;
            }
            bytesQueued += size;

            yield res.body
                ? { name: entryName, input: res }
                : { name: entryName, input: new Uint8Array(0) };
        }

        if (skipped.length > 0) {
            yield {
                name: nameFor(ZIP_REPORT_NAME),
                input: buildReport(skipped, requestedCount),
                lastModified: new Date(),
            };
        }
    } finally {
        // Normally empty. Non-empty when the consumer stopped early (client
        // disconnected, or a Drive body failed mid-stream): release the
        // prefetched responses so their sockets close.
        for (const p of pending) {
            void p.then((r) => { if (r instanceof Response) discard(r); });
        }
    }
}

function discard(res: Response) {
    res.body?.cancel().catch(() => { /* already closed */ });
}

function buildReport(skipped: SkippedDownloadFile[], requestedCount: number): string {
    const lines = skipped.map((s) => `- ${s.name}: ${s.reason}`);
    return [
        `Relay could not include ${skipped.length} of ${requestedCount} requested file${requestedCount === 1 ? '' : 's'} in this zip.`,
        '',
        ...lines,
        '',
    ].join('\r\n');
}

/**
 * Pass-through that logs when the zip stream dies mid-transfer. The browser
 * sees the failure as an interrupted download; without this the server side
 * left no trace.
 */
export function logStreamFailure(
    zip: ReadableStream<Uint8Array>,
    entryCount: number,
    /** Called when the client goes away — aborts in-flight Drive fetches */
    onCancel?: () => void,
): ReadableStream<Uint8Array> {
    const reader = zip.getReader();
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (err) {
                logger.error('download-zip', 'Zip stream failed mid-transfer', { entryCount, error: String(err) });
                controller.error(err);
            }
        },
        cancel(reason) {
            // client-zip doesn't run zipEntries' cleanup on cancel, and
            // request.signal isn't guaranteed to fire on disconnect — abort
            // the Drive fetches explicitly so their sockets close now.
            onCancel?.();
            return reader.cancel(reason);
        },
    });
}
