import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createClient as createServerClient } from '@/lib/supabase/server';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
    // Auth check — require authenticated session
    const supabaseAuth = await createServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        // Latest sync log
        const { data: latestSync } = await supabase
            .from('sync_logs')
            .select('*')
            .order('finished_at', { ascending: false })
            .limit(1)
            .single();

        // Average sync duration (for estimated time)
        const { data: recentSyncs } = await supabase
            .from('sync_logs')
            .select('duration_secs')
            .order('finished_at', { ascending: false })
            .limit(5);

        const avgDuration = recentSyncs && recentSyncs.length > 0
            ? recentSyncs.reduce((sum, s) => sum + s.duration_secs, 0) / recentSyncs.length
            : null;

        // Asset stats (aggregated from assets table)
        const { count: totalAssets } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true);

        const { count: photoCount } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .eq('asset_type', 'photo');

        const { count: videoCount } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .eq('asset_type', 'video');

        const { count: embeddedCount } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .not('embedding', 'is', null);

        const { count: withOrganic } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .not('organic_rights', 'is', null);

        const { count: withPaid } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', true)
            .not('paid_rights', 'is', null);

        // Trash count
        const { count: trashCount } = await supabase
            .from('assets')
            .select('*', { count: 'exact', head: true })
            .eq('is_active', false)
            .not('deleted_at', 'is', null);

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
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
