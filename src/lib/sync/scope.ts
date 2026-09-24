/**
 * Sync scope — which top-level Drive folders the library includes.
 *
 * The single implementation used by the cron sync (crawl, shortcuts, orphan
 * classification), the in-app ingest, and the scope-check API. Folder names
 * are matched case-insensitively and ignoring surrounding whitespace; the
 * copies this replaced disagreed on trimming.
 *
 * No app-alias imports: scripts import this module by relative path.
 */

/** Normalize the configured sync_folders list for matching. */
export function normalizeSyncFolders(folders: readonly string[] | null | undefined): string[] {
    return (folders ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean);
}

/** The top-level folder of a path ("/Photo Library/2026/x" → "photo library"). */
export function topFolderOf(folderPath: string | null | undefined): string {
    return (folderPath ?? '').split('/').filter(Boolean)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Whether a folder path is inside the sync scope. `normalizedFolders` must
 * come from normalizeSyncFolders. An empty list means no filter — everything
 * is in scope (see the `?? []` gotcha in CLAUDE.md).
 */
export function isInSyncScope(folderPath: string | null | undefined, normalizedFolders: readonly string[]): boolean {
    if (normalizedFolders.length === 0) return true;
    return normalizedFolders.includes(topFolderOf(folderPath));
}
