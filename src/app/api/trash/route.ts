import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';
import { PURGE_AFTER_DAYS } from '@/lib/sync/constants';

interface TrashRow {
    id: string;
    name: string;
    thumbnail_url: string | null;
    folder_path: string | null;
    asset_type: string;
    deleted_at: string;
    deleted_reason: string | null;
}

/**
 * GET /api/trash — list assets pending deletion
 */
export async function GET() {
    // Auth check — require authenticated session
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Paginated: PostgREST caps a select at 1000 rows, and out-of-scope rows
    // are never purged, so de-scoping one large folder can exceed that.
    const supabase = getAdminClient();
    const data: TrashRow[] = [];
    for (let from = 0; ; from += 1000) {
        const { data: page, error } = await supabase
            .from('assets')
            .select('id, name, thumbnail_url, folder_path, asset_type, deleted_at, deleted_reason')
            .eq('is_active', false)
            .not('deleted_at', 'is', null)
            .order('deleted_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, from + 999);

        if (error) {
            return NextResponse.json({ error: 'Failed to load trash' }, { status: 500 });
        }
        data.push(...((page ?? []) as TrashRow[]));
        if (!page || page.length < 1000) break;
    }

    // Add days remaining before purge. Out-of-scope assets are exempt from
    // the purge (the Drive files still exist, only the allowlist changed),
    // so they carry no countdown.
    const now = Date.now();
    const items = data.map((asset) => {
        const reason = asset.deleted_reason ?? 'orphaned';
        if (reason === 'out-of-scope') {
            return { ...asset, daysRemaining: null, deleted_reason: reason };
        }
        const deletedAt = new Date(asset.deleted_at).getTime();
        const purgeAt = deletedAt + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
        const daysRemaining = Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)));
        return {
            ...asset,
            daysRemaining,
            deleted_reason: reason,
        };
    });

    return NextResponse.json({ items, count: items.length });
}

/**
 * POST /api/trash — restore or purge an asset
 * Body: { action: 'restore' | 'purge', id: string }
 */
export async function POST(request: NextRequest) {
    // Auth check — require authenticated session
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { action, id } = body;

    if (!id || !action) {
        return NextResponse.json({ error: 'Missing id or action' }, { status: 400 });
    }

    const supabase = getAdminClient();

    if (action === 'restore') {
        // Guard on trash state and verify a row changed — Supabase reports
        // success for an update that matches nothing.
        const { data, error } = await supabase
            .from('assets')
            .update({ is_active: true, deleted_at: null, deleted_reason: null })
            .eq('id', id)
            .eq('is_active', false)
            .not('deleted_at', 'is', null)
            .select('id');

        if (error) {
            return NextResponse.json({ error: 'Restore failed' }, { status: 500 });
        }
        if (!data || data.length === 0) {
            return NextResponse.json({ error: 'Asset not found in trash' }, { status: 404 });
        }
        return NextResponse.json({ success: true, action: 'restored' });
    }

    if (action === 'purge') {
        // Only assets actually in the trash are purgeable — without the
        // trashed-state guard, any asset UUID could be hard-deleted here,
        // skipping the 14-day grace period. The row goes first, with the
        // guard in the DELETE itself, so a concurrent restore can't end up
        // with a live row whose thumbnails (including an irreplaceable
        // custom video frame) were already removed.
        const { data: deleted, error } = await supabase
            .from('assets')
            .delete()
            .eq('id', id)
            .eq('is_active', false)
            .not('deleted_at', 'is', null)
            .select('drive_file_id');

        if (error) {
            return NextResponse.json({ error: 'Purge failed' }, { status: 500 });
        }
        if (!deleted || deleted.length === 0) {
            return NextResponse.json({ error: 'Asset not found in trash' }, { status: 404 });
        }

        const driveFileId = deleted[0].drive_file_id;
        await supabase.storage.from('thumbnails').remove([
            `${driveFileId}.webp`,
            `custom_${driveFileId}.webp`,
        ]);
        return NextResponse.json({ success: true, action: 'purged' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
