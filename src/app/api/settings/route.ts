import { NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

export async function GET() {
    // Auth check — require authenticated session
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const supabase = getAdminClient();

        // All queries are independent — run them concurrently
        const [
            { data: latestSync },
            { data: recentSyncs },
            { count: totalAssets },
            { count: photoCount },
            { count: videoCount },
            { count: embeddedCount },
            { count: withOrganic },
            { count: withPaid },
            { count: trashCount },
        ] = await Promise.all([
            supabase
                .from('sync_logs')
                .select('*')
                .eq('source', 'cron') // in-app ingests are logged here too
                .order('finished_at', { ascending: false })
                .limit(1)
                .single(),
            supabase
                .from('sync_logs')
                .select('duration_secs')
                .eq('source', 'cron')
                .order('finished_at', { ascending: false })
                .limit(5),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true)
                .eq('asset_type', 'photo'),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true)
                .eq('asset_type', 'video'),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true)
                .not('embedding', 'is', null),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true)
                .not('organic_rights', 'is', null),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', true)
                .not('paid_rights', 'is', null),
            supabase
                .from('assets')
                .select('*', { count: 'exact', head: true })
                .eq('is_active', false)
                .not('deleted_at', 'is', null),
        ]);

        const avgDuration = recentSyncs && recentSyncs.length > 0
            ? recentSyncs.reduce((sum, s) => sum + s.duration_secs, 0) / recentSyncs.length
            : null;

        // Next sync: cron runs every 6 hours at 0, 6, 12, 18 UTC
        const CRON_INTERVAL_HOURS = 6;
        const now = new Date();
        const currentHourUTC = now.getUTCHours();
        // Find the next cron hour (0, 6, 12, or 18)
        const nextCronHour = Math.ceil((currentHourUTC + 1) / CRON_INTERVAL_HOURS) * CRON_INTERVAL_HOURS;
        const nextCron = new Date(now);
        if (nextCronHour >= 24) {
            // Wraps to next day
            nextCron.setUTCDate(nextCron.getUTCDate() + 1);
            nextCron.setUTCHours(nextCronHour - 24, 0, 0, 0);
        } else {
            nextCron.setUTCHours(nextCronHour, 0, 0, 0);
        }
        const nextSync = nextCron.toISOString();

        return NextResponse.json({
            latestSync,
            nextSync,
            avgDuration,
            stats: {
                total: totalAssets || 0,
                photos: photoCount || 0,
                videos: videoCount || 0,
                embedded: embeddedCount || 0,
                withOrganic: withOrganic || 0,
                withPaid: withPaid || 0,
                trashCount: trashCount || 0,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
