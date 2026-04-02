import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getConfig, updateSetting } from '@/lib/config';
import { logger } from '@/lib/logger';

/**
 * GET /api/settings/config
 *
 * Returns the current app configuration (DB-first, env var fallback).
 */
export async function GET() {
    // Auth check
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const config = await getConfig();
        return NextResponse.json(config);
    } catch (err) {
        logger.error('settings', 'Failed to load config', { error: String(err) });
        return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 });
    }
}

/**
 * PUT /api/settings/config
 *
 * Updates a single setting.
 * Body: { key: string, value: unknown }
 */
export async function PUT(request: NextRequest) {
    // Auth check
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const { key, value } = await request.json();

        if (!key || value === undefined) {
            return NextResponse.json({ error: 'Missing key or value' }, { status: 400 });
        }

        // Whitelist allowed keys
        const ALLOWED_KEYS = ['shared_drive_id', 'sync_folders', 'drive_label_id', 'namer_label_ids', 'semantic_similarity_threshold', 'hidden_folders'];
        if (!ALLOWED_KEYS.includes(key)) {
            return NextResponse.json({ error: `Invalid setting key: ${key}` }, { status: 400 });
        }

        const result = await updateSetting(key, value, user.email);

        if (!result.success) {
            logger.error('settings', 'Failed to update setting', { key, error: result.error });
            return NextResponse.json({ error: result.error }, { status: 500 });
        }

        logger.info('settings', `Setting updated: ${key}`, { updatedBy: user.email });
        return NextResponse.json({ success: true, key });
    } catch (err) {
        logger.error('settings', 'Config update error', { error: String(err) });
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 });
    }
}
