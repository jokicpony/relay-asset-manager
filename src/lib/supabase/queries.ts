import type { Asset, AssetListPayload, FolderNode } from '@/types';
import { readCachedAssetList, writeCachedAssetList } from '@/lib/asset-cache';

// ---------------------------------------------------------------------------
// Fetch the full asset list payload via the server-side API route.
// Pass { fresh: true } after a mutation (relay, trash, ingest, sync) to
// bypass the browser's 60s HTTP cache — otherwise the change wouldn't be
// visible until the cache expires. Callers expand it (expandAssetList) and
// persist it for instant loads (writeCachedAssetList) once they've decided
// the response is still the newest one.
// ---------------------------------------------------------------------------
export async function fetchAssetPayload(options?: { fresh?: boolean }): Promise<AssetListPayload> {
    const res = await fetch('/api/assets', options?.fresh ? { cache: 'reload' } : undefined);
    if (res.status === 401 && typeof window !== 'undefined') {
        // Session expired mid-use — send the user back through sign-in
        window.location.href = '/login';
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch assets (${res.status})`);
    }
    return res.json() as Promise<AssetListPayload>;
}

/**
 * The last fetched asset list from IndexedDB, or null if none, unavailable,
 * or slower than `timeoutMs` — a stuck IndexedDB open must never delay the
 * network result.
 */
export async function loadCachedAssets(timeoutMs = 300): Promise<Asset[] | null> {
    const payload = await Promise.race([
        readCachedAssetList(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return payload ? expandAssetList(payload) : null;
}

export { writeCachedAssetList };

/**
 * Attach shortcut provenance to master assets and append one clone entry per
 * (asset, project folder) — the clone is how an asset shows up inside the
 * project folders it was relayed to.
 */
export function expandAssetList({ assets, shortcuts }: AssetListPayload): Asset[] {
    const foldersById = new Map<string, Set<string>>();
    for (const [assetId, folder] of shortcuts) {
        let set = foldersById.get(assetId);
        if (!set) foldersById.set(assetId, (set = new Set()));
        set.add(folder);
    }
    if (foldersById.size === 0) return assets;

    const out: Asset[] = [];
    const clones: Asset[] = [];
    for (const asset of assets) {
        const folders = foldersById.get(asset.id);
        if (!folders) {
            out.push(asset);
            continue;
        }
        const list = [...folders];
        out.push({ ...asset, shortcutFolders: list });
        for (const folder of list) {
            clones.push({
                ...asset,
                id: `${asset.id}::sc::${folder}`,
                folderPath: folder,
                isShortcut: true,
                originalFolderPath: asset.folderPath,
            });
        }
    }
    return out.concat(clones);
}

// ---------------------------------------------------------------------------
// Build folder tree from unique folder paths
// ---------------------------------------------------------------------------
export function buildFolderTree(assets: Asset[]): FolderNode {
    const root: FolderNode = {
        id: 'root',
        name: 'All Folders',
        path: '/',
        children: [],
    };

    // Collect unique folder paths
    const paths = new Set<string>();
    for (const a of assets) {
        if (a.folderPath && a.folderPath !== '/') {
            paths.add(a.folderPath);
        }
    }

    // Sort paths for consistent ordering
    const sorted = [...paths].sort();

    // Insert each path into the tree
    for (const fullPath of sorted) {
        const segments = fullPath.split('/').filter(Boolean);
        let current = root;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const pathSoFar = '/' + segments.slice(0, i + 1).join('/');

            let child = current.children.find((c) => c.path === pathSoFar);
            if (!child) {
                child = {
                    id: pathSoFar,
                    name: segment,
                    path: pathSoFar,
                    children: [],
                };
                current.children.push(child);
            }
            current = child;
        }
    }

    return root;
}
