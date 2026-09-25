/**
 * Download contract shared by the download queue (client) and
 * /api/drive/download (server). Kept dependency-free so it can be imported
 * from a 'use client' component.
 */

/** A file the user asked to download, as sent by the client. */
export interface DownloadRequestFile {
    driveFileId: string;
    name: string;
}

/** A requested file that won't be in the download, with a user-facing reason. */
export interface SkippedDownloadFile {
    driveFileId: string;
    name: string;
    reason: string;
}

/** Response of `POST /api/drive/download` with `mode: 'preflight'`. */
export interface DownloadPreflightResponse {
    /** Files that passed the scope + Drive checks, in request order. */
    ready: DownloadRequestFile[];
    /** Files that will not be downloaded, and why. */
    skipped: SkippedDownloadFile[];
    /** Sum of Drive-reported sizes of the ready files (0 when Drive omits size). */
    totalBytes: number;
}

// Zips are streamed through one serverless invocation, so they are bounded by
// the route's maxDuration (300s), not by the ZIP format (client-zip writes
// ZIP64 when needed). These caps keep a request comfortably inside that
// window and fail fast with a clear message instead of a download that dies
// half-way. Bigger selections should be split or fetched from Drive directly.
export const MAX_ZIP_FILES = 1000;

/**
 * Single-file downloads normally stream through Relay's server. That path is
 * bounded by the function's 300s limit, so files at least this large — the
 * ones at real risk of being cut off part-way — are handed to Google Drive's
 * own download in the user's browser session instead (every Relay user has
 * access to the shared drive). Relay still runs its library scope check (the
 * preflight) first. Kept high on purpose: the handoff opens a new tab.
 */
export const DIRECT_DRIVE_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Relayed files at least this large get a fail-safe "Download from Drive"
 * link in the queue, in case the relayed download stalls or is cut off.
 */
export const DRIVE_FALLBACK_HINT_BYTES = 100 * 1024 * 1024;

/** Google Drive's own download URL (`confirm=t` skips the "can't scan large file" page). */
export function driveDirectDownloadUrl(fileId: string): string {
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;
}
// Drive bodies stream one file at a time; ~1.5 GiB leaves headroom inside the
// route's 300s limit at realistic Drive throughput (5 GiB would need a
// sustained ~17 MB/s and gets cut off mid-zip, which the queue can't see).
export const MAX_ZIP_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GiB

/** Name of the entry appended to a zip when files failed while streaming. */
export const ZIP_REPORT_NAME = '_relay-download-report.txt';

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Make a client-supplied file name safe as a flat zip entry: no path
 * separators (a name like "../x" must not become a path on extraction), no
 * control characters, never empty or a dot-segment.
 */
export function sanitizeEntryName(name: string): string {
    const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
    if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
    return cleaned;
}

/**
 * Returns a function that hands out unique entry names for one archive.
 * Collisions get " (2)", " (3)"… before the extension. Comparison is
 * case-insensitive because macOS and Windows extract onto case-insensitive
 * file systems, where "A.jpg" and "a.jpg" would overwrite each other.
 */
export function createEntryNamer(): (name: string) => string {
    const used = new Set<string>();
    return (raw: string) => {
        const base = sanitizeEntryName(raw);
        let candidate = base;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) {
            const dot = base.lastIndexOf('.');
            candidate = dot > 0
                ? `${base.slice(0, dot)} (${n})${base.slice(dot)}`
                : `${base} (${n})`;
        }
        used.add(candidate.toLowerCase());
        return candidate;
    };
}
