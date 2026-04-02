import { createClient } from '@/lib/supabase/client';
import { Asset, FolderNode } from '@/types';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// DB row → frontend Asset mapper
// ---------------------------------------------------------------------------
interface DbAsset {
    id: string;
    drive_file_id: string;
    name: string;
    description: string | null;
    mime_type: string;
    asset_type: 'photo' | 'video';
    folder_path: string;
    thumbnail_url: string | null;
    preview_url: string | null;
    width: number;
    height: number;
    duration: number | null;
    organic_rights: string | null;
    organic_rights_expiration: string | null;
    paid_rights: string | null;
    paid_rights_expiration: string | null;
    creator: string | null;
    project_description: string | null;
    parsed_creator: string | null;
    parsed_shoot_date: string | null;
    parsed_shoot_description: string | null;
    tags: string[];
    created_at: string;
    updated_at: string;
    drive_created_at: string | null;
    drive_modified_at: string | null;
    file_size: number | null;
    is_active: boolean;
}

function mapDbAsset(row: DbAsset, shortcutFolders?: string[]): Asset {
    return {
        id: row.id,
        driveFileId: row.drive_file_id,
        name: row.name,
        description: row.description,
        mimeType: row.mime_type,
        assetType: row.asset_type,
        folderPath: row.folder_path,
        thumbnailUrl: row.thumbnail_url || '/placeholder-thumb.svg',
        previewUrl: row.preview_url ?? undefined,
        width: row.width || 400,
        height: row.height || 300,
        duration: row.duration ?? undefined,
        fileSize: row.file_size ?? undefined,
        organicRights: (row.organic_rights as Asset['organicRights']) ?? null,
        organicRightsExpiration: row.organic_rights_expiration,
        paidRights: (row.paid_rights as Asset['paidRights']) ?? null,
        paidRightsExpiration: row.paid_rights_expiration,
        creator: row.creator,
        projectDescription: row.project_description,
        tags: row.tags ?? [],
        createdAt: row.drive_created_at ?? row.created_at,
        updatedAt: row.drive_modified_at ?? row.updated_at,
        isActive: row.is_active,
        shortcutFolders,
    };
}

// ---------------------------------------------------------------------------
// Fetch assets from Supabase (paginated)
// ---------------------------------------------------------------------------
export async function fetchAssets(
    limit: number = 500,
    offset: number = 0,
    shortcutMap?: Map<string, string[]>
): Promise<Asset[]> {
    const supabase = createClient();
    const { data, error } = await supabase
        .from('assets')
        .select('*')
        .eq('is_active', true)
        .order('folder_path', { ascending: true })
        .order('name', { ascending: true })
        .range(offset, offset + limit - 1);

    if (error) {
        logger.error('assets', 'Failed to fetch assets', { error: error.message });
        return [];
    }

    return (data as DbAsset[]).map((row) =>
        mapDbAsset(row, shortcutMap?.get(row.id))
    );
}

// ---------------------------------------------------------------------------
// Fetch ALL assets (iterates through pages), enriched with shortcuts
// ---------------------------------------------------------------------------
export async function fetchAllAssets(): Promise<Asset[]> {
    // Fetch shortcuts FIRST so we can bake them into assets during mapping
    let shortcutMap = new Map<string, string[]>();
    try {
        const supabase = createClient();
        const { data: shortcuts, error: scErr } = await supabase
            .from('shortcuts')
            .select('target_asset_id, project_folder_path');

        if (scErr) {
            logger.warn('shortcuts', 'Query error', { error: scErr.message });
        } else if (shortcuts && shortcuts.length > 0) {
            for (const s of shortcuts) {
                const existing = shortcutMap.get(s.target_asset_id) || [];
                existing.push(s.project_folder_path);
                shortcutMap.set(s.target_asset_id, existing);
            }
            logger.info('shortcuts', `${shortcutMap.size} assets have shortcut references`);
        }
    } catch (err) {
        logger.warn('shortcuts', 'Failed to fetch', { error: String(err) });
    }

    const PAGE_SIZE = 1000;
    const allAssets: Asset[] = [];
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const batch = await fetchAssets(PAGE_SIZE, offset, shortcutMap);
        allAssets.push(...batch);
        hasMore = batch.length === PAGE_SIZE;
        offset += PAGE_SIZE;
    }

    // Create shortcut clone entries — these appear in project folder views
    // Each shortcut gets a copy of the master asset with folderPath = project folder
    if (shortcutMap.size > 0) {
        const assetById = new Map(allAssets.map(a => [a.id, a]));
        for (const [assetId, folders] of shortcutMap) {
            const master = assetById.get(assetId);
            if (!master) continue;
            const uniqueFolders = [...new Set(folders)];
            for (const folder of uniqueFolders) {
                allAssets.push({
                    ...master,
                    id: `${assetId}::sc::${folder}`,
                    folderPath: folder,
                    isShortcut: true,
                    originalFolderPath: master.folderPath,
                    shortcutFolders: undefined, // clones don't need the "Also In" list
                });
            }
        }
        logger.info('shortcuts', `Created ${allAssets.length - assetById.size} shortcut clones`);
    }

    return allAssets;
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
