import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { Asset } from '@/types';
import { logger } from '@/lib/logger';

// Columns to fetch — excludes `embedding`, `deleted_at`, `deleted_reason`
const ASSET_COLUMNS = [
    'id', 'drive_file_id', 'name', 'description', 'mime_type', 'asset_type',
    'folder_path', 'thumbnail_url', 'preview_url', 'width', 'height', 'duration',
    'organic_rights', 'organic_rights_expiration', 'paid_rights', 'paid_rights_expiration',
    'creator', 'project_description', 'parsed_creator', 'parsed_shoot_date',
    'parsed_shoot_description', 'tags', 'created_at', 'updated_at',
    'drive_created_at', 'drive_modified_at', 'file_size', 'is_active',
].join(', ');

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

/**
 * GET /api/assets
 *
 * Returns all active assets with shortcut enrichment.
 * Runs server-side for lower latency to Supabase + automatic gzip compression.
 */
export async function GET() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        // Fetch shortcuts and first asset batch in parallel
        const shortcutMap = new Map<string, string[]>();
        const shortcutPromise = supabase
            .from('shortcuts')
            .select('target_asset_id, project_folder_path')
            .then(({ data, error }) => {
                if (error) {
                    logger.warn('shortcuts', 'Query error', { error: error.message });
                    return;
                }
                if (data) {
                    for (const s of data) {
                        const existing = shortcutMap.get(s.target_asset_id) || [];
                        existing.push(s.project_folder_path);
                        shortcutMap.set(s.target_asset_id, existing);
                    }
                }
            });

        // Fetch all asset pages
        const PAGE_SIZE = 1000;
        const allRows: DbAsset[] = [];
        let offset = 0;
        let hasMore = true;

        // Start shortcuts fetch, then begin paginated asset fetch
        await shortcutPromise;

        while (hasMore) {
            const { data, error } = await supabase
                .from('assets')
                .select(ASSET_COLUMNS)
                .eq('is_active', true)
                .order('folder_path', { ascending: true })
                .order('name', { ascending: true })
                .range(offset, offset + PAGE_SIZE - 1);

            if (error) {
                logger.error('assets', 'Failed to fetch assets', { error: error.message });
                return NextResponse.json({ error: 'Failed to fetch assets' }, { status: 500 });
            }

            allRows.push(...(data as unknown as DbAsset[]));
            hasMore = data.length === PAGE_SIZE;
            offset += PAGE_SIZE;
        }

        // Map to frontend Asset type with shortcut enrichment
        const allAssets: Asset[] = allRows.map((row) =>
            mapDbAsset(row, shortcutMap.get(row.id))
        );

        // Create shortcut clone entries
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
                        shortcutFolders: undefined,
                    });
                }
            }
        }

        logger.info('assets', `Served ${allAssets.length} assets (${allRows.length} real + ${allAssets.length - allRows.length} shortcuts)`);

        return NextResponse.json(allAssets, {
            headers: {
                'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
            },
        });
    } catch (err) {
        logger.error('assets', 'Failed to load assets', { error: String(err) });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
