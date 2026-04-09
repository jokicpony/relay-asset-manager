import { Asset, FolderNode } from '@/types';

// ---------------------------------------------------------------------------
// Fetch ALL assets via server-side API route (single request, cached)
// ---------------------------------------------------------------------------
export async function fetchAllAssets(): Promise<Asset[]> {
    const res = await fetch('/api/assets');
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch assets (${res.status})`);
    }
    return res.json();
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
