/**
 * Resolve a Drive folder ID to its canonical path (e.g. "/A/B/C").
 *
 * Walks the parent chain via the Drive API. Uses the shared-drive root
 * (`driveId`) as the terminator. Caller-supplied `pathCache` lets multiple
 * lookups in the same request share intermediate results.
 *
 * Returns "/" for the drive root, "/unknown" if the chain can't be resolved
 * (e.g. permission denied on an ancestor).
 */
export async function resolveFolderPathById(
    accessToken: string,
    folderId: string,
    driveId: string,
    pathCache: Map<string, string> = new Map()
): Promise<{ path: string; breadcrumbs: { id: string; name: string }[] }> {
    if (!folderId || folderId === driveId) {
        return { path: '/', breadcrumbs: [] };
    }

    // Walk up by repeatedly fetching the current folder's metadata.
    const chain: { id: string; name: string }[] = [];
    let currentId: string | undefined = folderId;

    while (currentId && currentId !== driveId) {
        if (pathCache.has(currentId)) {
            // Cache stores full path of `currentId`; prepend its breadcrumbs.
            const cachedPath = pathCache.get(currentId)!;
            const cachedNames = cachedPath.split('/').filter(Boolean);
            // We can't recover IDs from the cached path string, so for the
            // breadcrumb structure we only return what we walked. Path is correct
            // either way — that's the field used for `project_folder_path`.
            const path = `${cachedPath}${chain.length > 0 ? '/' + chain.map(c => c.name).join('/') : ''}`;
            return {
                path,
                // Best-effort breadcrumbs: cached ancestors lose their IDs.
                breadcrumbs: [
                    ...cachedNames.map((name) => ({ id: '', name })),
                    ...chain,
                ],
            };
        }

        const res = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(currentId)}?fields=id,name,parents&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!res.ok) {
            return { path: '/unknown', breadcrumbs: chain };
        }

        const data = (await res.json()) as { id: string; name: string; parents?: string[] };
        chain.unshift({ id: data.id, name: data.name });
        currentId = data.parents?.[0];
    }

    const path = '/' + chain.map((c) => c.name).join('/');

    // Populate the cache for every prefix along the chain.
    for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        const prefix = '/' + chain.slice(0, i + 1).map((c) => c.name).join('/');
        if (!pathCache.has(node.id)) pathCache.set(node.id, prefix);
    }

    return { path, breadcrumbs: chain };
}
