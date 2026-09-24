import { fetchWithDriveRetry } from '../sync/drive-retry';

/**
 * Resolve a Drive folder ID to its canonical path (e.g. "/A/B/C") by walking
 * the parent chain, and report whether it sits under a `[relay-ignore]`
 * folder. Used by the in-app ingest (per-file scope + ignore checks), relays
 * (shortcut target path), and the folder-path API. The cron sync resolves
 * paths from a bulk folder-tree prefetch instead — at library scale that's
 * a few list calls rather than one lookup per folder.
 *
 * `cache` is caller-owned and request-scoped (never module-level: concurrent
 * requests would share and clear each other's entries); every folder walked
 * is cached with its full path and inherited ignore flag.
 *
 * Returns "/" for the drive root, "/unknown" if the chain can't be resolved
 * (e.g. permission denied on an ancestor) — which callers treat as out of
 * scope.
 */

export interface FolderInfo {
    path: string;
    /** This folder or an ancestor has [relay-ignore] in its description */
    ignored: boolean;
}

export const RELAY_IGNORE_TAG = '[relay-ignore]';

export async function resolveFolderPathById(
    accessToken: string,
    folderId: string,
    driveId: string,
    cache: Map<string, FolderInfo> = new Map(),
): Promise<FolderInfo & { breadcrumbs: { id: string; name: string }[] }> {
    if (!folderId || folderId === driveId) {
        return { path: '/', ignored: false, breadcrumbs: [] };
    }

    // Walk up until the drive root or a cached ancestor.
    const chain: { id: string; name: string; tagged: boolean }[] = [];
    let base: FolderInfo = { path: '/', ignored: false };
    let baseNames: string[] = [];
    let currentId: string | undefined = folderId;

    while (currentId && currentId !== driveId) {
        const cached = cache.get(currentId);
        if (cached) {
            base = cached;
            baseNames = cached.path.split('/').filter(Boolean);
            break;
        }

        const unresolved = { path: '/unknown', ignored: false, breadcrumbs: chain.map(({ id, name }) => ({ id, name })) };
        let data: { id: string; name: string; parents?: string[]; description?: string };
        try {
            const res = await fetchWithDriveRetry(
                `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(currentId)}?fields=id,name,parents,description&supportsAllDrives=true`,
                { headers: { Authorization: `Bearer ${accessToken}` } },
                2, // callers run inside request time limits
            );
            if (!res.ok) return unresolved;
            data = await res.json();
        } catch {
            return unresolved; // network error — treated as out of scope, as before
        }
        if (chain.some((n) => n.id === data.id)) return unresolved; // parent cycle guard
        chain.unshift({ id: data.id, name: data.name, tagged: Boolean(data.description?.includes(RELAY_IGNORE_TAG)) });
        currentId = data.parents?.[0];
    }

    // Cache every walked folder with its full path and inherited ignore flag.
    let info = base;
    for (const node of chain) {
        info = {
            path: info.path === '/' ? `/${node.name}` : `${info.path}/${node.name}`,
            ignored: info.ignored || node.tagged,
        };
        cache.set(node.id, info);
    }

    return {
        ...info,
        // Best-effort: ancestors that came from the cache lose their IDs.
        breadcrumbs: [
            ...baseNames.map((name) => ({ id: '', name })),
            ...chain.map(({ id, name }) => ({ id, name })),
        ],
    };
}
