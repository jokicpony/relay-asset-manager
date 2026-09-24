import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * GET /api/sync/activity?limit=20
 *
 * Recent ingestion activity (scheduled syncs + in-app ingests) from
 * sync_logs, plus a health summary for the app-wide indicator:
 *   issue = 'failed'  — the latest scheduled sync failed
 *           'stale'   — no scheduled sync has succeeded in STALE_AFTER_HOURS
 *           null      — healthy
 * `limit=0` returns only the health summary (cheap enough for page load).
 */

// The cron runs every 6h — two missed runs plus slack before flagging
const STALE_AFTER_HOURS = 13;

export async function GET(request: NextRequest) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const raw = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 50) : 20;

    const [latestRes, lastGoodRes, entriesRes] = await Promise.all([
        supabase.from('sync_logs')
            .select('status, finished_at, error_message')
            .eq('source', 'cron')
            .order('finished_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        supabase.from('sync_logs')
            .select('finished_at')
            .eq('source', 'cron')
            .in('status', ['success', 'partial'])
            .order('finished_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
        limit > 0
            ? supabase.from('sync_logs')
                .select('id, source, status, started_at, finished_at, duration_secs, assets_found, assets_upserted, '
                    + 'upsert_errors, thumbnails_uploaded, thumbnail_errors, soft_deleted, restored, purged, '
                    + 're_embedded, error_message, details')
                .order('finished_at', { ascending: false })
                .limit(limit)
            : Promise.resolve({ data: [], error: null }),
    ]);

    const failure = latestRes.error ?? lastGoodRes.error ?? entriesRes.error;
    if (failure) {
        logger.error('sync-activity', 'Failed to read sync_logs', { error: failure.message });
        return NextResponse.json({ error: 'Failed to load sync activity' }, { status: 500 });
    }

    const latest = latestRes.data;
    const lastGoodAt = lastGoodRes.data?.finished_at ?? null;
    const stale = !lastGoodAt || Date.now() - new Date(lastGoodAt).getTime() > STALE_AFTER_HOURS * 3_600_000;
    const issue = latest?.status === 'failed' ? 'failed' : stale ? 'stale' : null;

    return NextResponse.json({
        health: {
            issue,
            latestStatus: latest?.status ?? null,
            latestAt: latest?.finished_at ?? null,
            latestError: latest?.error_message ?? null,
            lastGoodAt,
            staleAfterHours: STALE_AFTER_HOURS,
        },
        entries: entriesRes.data ?? [],
    });
}
