/**
 * MIME type sets for the sync pipeline — the single definition used by the
 * overnight crawler (scripts/sync.ts) and the namer's targeted ingest.
 *
 * No app-alias imports here: scripts import this module by relative path
 * under tsx, same as src/lib/filename-utils.
 */
export const IMAGE_MIMES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'image/tiff', 'image/heic', 'image/heif',
]);

export const VIDEO_MIMES = new Set([
    'video/mp4', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/webm', 'video/mpeg',
]);

export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export function isAssetMime(mimeType: string): boolean {
    return IMAGE_MIMES.has(mimeType) || VIDEO_MIMES.has(mimeType);
}
