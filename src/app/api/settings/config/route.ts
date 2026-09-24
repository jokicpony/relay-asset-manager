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

const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');

/**
 * Per-key value validation. Returns an error message, or null when valid.
 * Two values are dangerous rather than merely wrong: an empty
 * shared_drive_id disables the shared-drive scope checks, and an empty
 * sync_folders list means "sync every folder in the drive" (see the `?? []`
 * gotcha in CLAUDE.md) — both are rejected outright.
 */
const VALIDATORS: Record<string, (v: unknown) => string | null> = {
    shared_drive_id: (v) =>
        typeof v === 'string' && v.trim() !== '' ? null : 'Shared Drive ID cannot be empty',
    sync_folders: (v) =>
        !isStringArray(v) ? 'Sync folders must be a list of folder names'
            : v.length === 0 ? 'Keep at least one sync folder — an empty list syncs every folder in the drive'
                : null,
    drive_label_id: (v) => (typeof v === 'string' ? null : 'Label ID must be a string'),
    namer_label_ids: (v) => (isStringArray(v) ? null : 'Label IDs must be a list of IDs'),
    semantic_similarity_threshold: (v) =>
        typeof v === 'number' && v >= 0 && v <= 1 ? null : 'Threshold must be a number between 0 and 1',
    hidden_folders: (v) => (isStringArray(v) ? null : 'Hidden folders must be a list of paths'),
    rights_label_config: (v) =>
        v && typeof v === 'object' && 'fieldIds' in v && 'choiceMap' in v
            ? null : 'Rights label config must include fieldIds and choiceMap',
};

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

        // Whitelist allowed keys, each with a value check
        const validate = typeof key === 'string' && Object.hasOwn(VALIDATORS, key) ? VALIDATORS[key] : null;
        if (!validate) {
            return NextResponse.json({ error: `Invalid setting key: ${key}` }, { status: 400 });
        }
        const invalid = validate(value);
        if (invalid) {
            return NextResponse.json({ error: invalid }, { status: 400 });
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
