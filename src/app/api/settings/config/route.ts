import { NextRequest, NextResponse } from 'next/server';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { getConfig, updateSetting } from '@/lib/config';
import { logger } from '@/lib/logger';
import { isDriveId } from '@/lib/google/drive-scope';
import { getDriveAccessToken } from '@/lib/google/auth';

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
        isDriveId(v) ? null : 'Shared Drive ID must be a valid Drive ID',
    sync_folders: (v) =>
        !isStringArray(v) ? 'Sync folders must be a list of folder names'
            : v.length === 0 ? 'Keep at least one sync folder — an empty list syncs every folder in the drive'
                : null,
    drive_label_id: (v) => (typeof v === 'string' ? null : 'Label ID must be a string'),
    namer_label_ids: (v) => (isStringArray(v) ? null : 'Label IDs must be a list of IDs'),
    semantic_similarity_threshold: (v) =>
        typeof v === 'number' && v >= 0 && v <= 1 ? null : 'Threshold must be a number between 0 and 1',
    hidden_folders: (v) => (isStringArray(v) ? null : 'Hidden folders must be a list of paths'),
    // The sync parses every file's labels with this — a malformed value would
    // crash the whole run on the first file, so the shape is checked fully.
    rights_label_config: (v) => {
        const c = v as { fieldIds?: Record<string, unknown>; choiceMap?: Record<string, unknown> } | null;
        const fields = ['organicRights', 'organicExpiration', 'paidRights', 'paidExpiration'];
        if (!c || typeof c !== 'object' || !c.fieldIds || typeof c.fieldIds !== 'object'
            || !fields.every((f) => typeof c.fieldIds![f] === 'string')) {
            return `Rights label config needs fieldIds with string ${fields.join(', ')}`;
        }
        if (!c.choiceMap || typeof c.choiceMap !== 'object' || Array.isArray(c.choiceMap)
            || !Object.values(c.choiceMap).every((x) => x === 'unlimited' || x === 'limited' || x === 'expired')) {
            return 'Rights label choiceMap must map choice IDs to unlimited / limited / expired';
        }
        return null;
    },
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

        // Changing the shared drive re-points the whole library, relays and the
        // Namer: only accept a shared drive the service account can open (a
        // typo would otherwise silently break every Drive operation).
        if (key === 'shared_drive_id') {
            const token = await getDriveAccessToken();
            const check = await fetch(
                `https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(value)}?fields=id`,
                { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }
            );
            if (!check.ok) {
                return NextResponse.json(
                    { error: 'That ID is not a shared drive the service account can access' },
                    { status: 400 }
                );
            }
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
