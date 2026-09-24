import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { Asset, AssetListPayload } from '@/types';
import { logger } from '@/lib/logger';

// Columns to fetch — only what the client reads. Excludes `embedding`,
// the trash fields, and preview_url / is_active / updated_at (never used by
// the browser; the list is ~8k entries, so every field counts).
const ASSET_COLUMNS = [
    'id', 'drive_file_id', 'name', 'description', 'mime_type', 'asset_type',
    'folder_path', 'thumbnail_url', 'thumb_color', 'width', 'height', 'duration',
    'organic_rights', 'organic_rights_expiration', 'paid_rights', 'paid_rights_expiration',
    'creator', 'project_description', 'tags', 'created_at',
    'drive_created_at', 'file_size',
].join(', ');

const PAGE_SIZE = 1000; // PostgREST's max rows per select

interface DbAsset {
    id: string;
    drive_file_id: string;
    name: string;
    description: string | null;
    mime_type: string;
    asset_type: 'photo' | 'video';
    folder_path: string;
    thumbnail_url: string | null;
    thumb_color: string | null;
    width: number;
    height: number;
    duration: number | null;
    organic_rights: string | null;
    organic_rights_expiration: string | null;
    paid_rights: string | null;
    paid_rights_expiration: string | null;
    creator: string | null;
    project_description: string | null;
    tags: string[];
    created_at: string;
    drive_created_at: string | null;
    file_size: number | null;
}

function mapDbAsset(row: DbAsset): Asset {
    return {
        id: row.id,
        driveFileId: row.drive_file_id,
        name: row.name,
        description: row.description,
        mimeType: row.mime_type,
        assetType: row.asset_type,
        folderPath: row.folder_path,
        thumbnailUrl: row.thumbnail_url || '/placeholder-thumb.svg',
        thumbColor: row.thumb_color ?? undefined,
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
    };
}

/**
 * GET /api/assets
 *
 * Returns all active assets plus shortcut links as an AssetListPayload.
 * Shortcut clone entries are built client-side (expandAssetList) rather
 * than serialized here.
 */
export async function GET() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const assetPage = (from: number) => supabase
            .from('assets')
            .select(ASSET_COLUMNS)
            .eq('is_active', true)
            .order('folder_path', { ascending: true })
            .order('name', { ascending: true })
            // Unique tie-breaker: Drive allows duplicate names in a folder,
            // and offset paging over non-unique sort keys can skip or
            // repeat rows at page boundaries.
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);

        // Shortcuts, paginated — PostgREST caps a select at 1000 rows.
        const shortcutsPromise = (async () => {
            const pairs: [string, string][] = [];
            for (let from = 0; ; from += PAGE_SIZE) {
                const { data, error } = await supabase
                    .from('shortcuts')
                    .select('target_asset_id, project_folder_path')
                    .order('id')
                    .range(from, from + PAGE_SIZE - 1);
                if (error) {
                    logger.warn('shortcuts', 'Query error', { error: error.message });
                    break;
                }
                for (const s of data ?? []) pairs.push([s.target_asset_id, s.project_folder_path]);
                if (!data || data.length < PAGE_SIZE) break;
            }
            return pairs;
        })();

        // Count first, then fetch every page concurrently — the pages used to
        // be fetched one after another (~7 round trips at the current size).
        const { count, error: countErr } = await supabase
            .from('assets')
            .select('id', { count: 'exact', head: true })
            .eq('is_active', true);
        if (countErr) {
            logger.error('assets', 'Failed to count assets', { error: countErr.message });
            return NextResponse.json({ error: 'Failed to fetch assets' }, { status: 500 });
        }

        const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
        const pages = await Promise.all(
            Array.from({ length: pageCount }, (_, i) => assetPage(i * PAGE_SIZE))
        );

        const rows: DbAsset[] = [];
        for (const { data, error } of pages) {
            if (error) {
                logger.error('assets', 'Failed to fetch assets', { error: error.message });
                return NextResponse.json({ error: 'Failed to fetch assets' }, { status: 500 });
            }
            rows.push(...(data as unknown as DbAsset[]));
        }
        // Rows inserted after the count: keep reading past the last page.
        for (let from = pageCount * PAGE_SIZE, last = pages[pages.length - 1].data?.length ?? 0;
            last === PAGE_SIZE; from += PAGE_SIZE) {
            const { data, error } = await assetPage(from);
            if (error || !data) break;
            rows.push(...(data as unknown as DbAsset[]));
            last = data.length;
        }

        // A concurrent insert/delete can shift offsets between pages — dedupe.
        const seen = new Set<string>();
        const assets: Asset[] = [];
        for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            assets.push(mapDbAsset(row));
        }

        const shortcuts = await shortcutsPromise;
        logger.info('assets', `Served ${assets.length} assets + ${shortcuts.length} shortcut links`);

        const payload: AssetListPayload = { assets, shortcuts };
        return NextResponse.json(payload, {
            headers: {
                'Cache-Control': 'private, max-age=60, stale-while-revalidate=300',
            },
        });
    } catch (err) {
        logger.error('assets', 'Failed to load assets', { error: String(err) });
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
