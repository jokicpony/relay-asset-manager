import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

    // Try with deleted_reason column; fall back if migration hasn't been applied
    let data: any[] | null = null;
    let hasReasonColumn = true;

    const result1 = await supabase
        .from('assets')
        .select('id, name, thumbnail_url, folder_path, asset_type, deleted_at, deleted_reason')
        .eq('is_active', false)
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: true });

    if (result1.error && result1.error.message.includes('deleted_reason')) {
        // Column doesn't exist yet — query without it
        hasReasonColumn = false;
        const result2 = await supabase
            .from('assets')
            .select('id, name, thumbnail_url, folder_path, asset_type, deleted_at')
            .eq('is_active', false)
            .not('deleted_at', 'is', null)
            .order('deleted_at', { ascending: true });

        if (result2.error) {
            return NextResponse.json({ error: result2.error.message }, { status: 500 });
        }
        data = result2.data;
    } else if (result1.error) {
        return NextResponse.json({ error: result1.error.message }, { status: 500 });
    } else {
        data = result1.data;
    }

    // Add days remaining before purge
    const now = Date.now();
    const PURGE_DAYS = 14;
    const items = (data || []).map((asset) => {
        const deletedAt = new Date(asset.deleted_at).getTime();
        const purgeAt = deletedAt + PURGE_DAYS * 24 * 60 * 60 * 1000;
        const daysRemaining = Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)));
        return {
            ...asset,
            daysRemaining,
            deleted_reason: hasReasonColumn ? (asset.deleted_reason ?? 'orphaned') : 'orphaned',
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

    if (action === 'restore') {
        // Try with deleted_reason; fall back if column doesn't exist
        let restoreError: any = null;
        const { error: err1 } = await supabase
            .from('assets')
            .update({ is_active: true, deleted_at: null, deleted_reason: null })
            .eq('id', id);

        if (err1 && err1.message.includes('deleted_reason')) {
            const { error: err2 } = await supabase
                .from('assets')
                .update({ is_active: true, deleted_at: null })
                .eq('id', id);
            restoreError = err2;
        } else {
            restoreError = err1;
        }

        if (restoreError) {
            return NextResponse.json({ error: restoreError.message }, { status: 500 });
        }
        return NextResponse.json({ success: true, action: 'restored' });
    }

    if (action === 'purge') {
        // Get the asset to find its drive_file_id for thumbnail cleanup
        const { data: asset, error: fetchErr } = await supabase
            .from('assets')
            .select('drive_file_id')
            .eq('id', id)
            .single();

        if (fetchErr || !asset) {
            return NextResponse.json({ error: 'Asset not found' }, { status: 404 });
        }

        // Delete thumbnail from storage
        await supabase.storage.from('thumbnails').remove([`${asset.drive_file_id}.webp`]);

        // Hard-delete the row
        const { error } = await supabase.from('assets').delete().eq('id', id);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ success: true, action: 'purged' });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
