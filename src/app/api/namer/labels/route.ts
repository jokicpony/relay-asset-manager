/**
 * Namer Labels API — Fetch available Drive Labels.
 *
 * The `labels.list` endpoint requires a Google Workspace `customer` parameter
 * that service accounts via WIF don't have. Instead, we fetch each configured
 * label individually by ID using the stable v2 API, which works with service
 * account tokens.
 *
 * Label IDs are stored in `namer_label_ids` in app_settings (falls back to
 * the single `drive_label_id` used for rights management).
 *
 * GET — Returns: { labels: DriveLabel[] }
 */

import { NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { getConfig } from '@/lib/config';
import { DRIVE_CALL_TIMEOUT_MS, namerErrorResponse } from '@/lib/namer/route-errors';

// Label fetches run in parallel, each ≤15s
export const maxDuration = 30;

const LABELS_API = 'https://drivelabels.googleapis.com/v2/labels';

export async function GET() {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const token = await getDriveAccessToken();
        const config = await getConfig();
        const labelIds = config.namerLabelIds;

        if (labelIds.length === 0) {
            logger.warn('namer-labels', 'No label IDs configured (namer_label_ids or drive_label_id)');
            return NextResponse.json({ labels: [] });
        }

        logger.info('namer-labels', `Fetching ${labelIds.length} labels by ID`, { labelIds });

        // Fetch each label individually — Promise.allSettled for resilience
        const results = await Promise.allSettled(
            labelIds.map(async (labelId) => {
                const url = `${LABELS_API}/${labelId}?view=LABEL_VIEW_FULL`;
                const res = await fetch(url, {
                    headers: { Authorization: `Bearer ${token}` },
                    signal: AbortSignal.timeout(DRIVE_CALL_TIMEOUT_MS),
                });
                if (!res.ok) {
                    const errBody = await res.text();
                    logger.error('namer-labels', `Failed to fetch label ${labelId}`, {
                        status: res.status,
                        error: errBody.substring(0, 500),
                    });
                    throw new Error(`Label ${labelId}: ${res.status}`);
                }
                return res.json();
            })
        );

        const labels = results
            .filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === 'fulfilled')
            .map(r => r.value);

        const failed = results.filter(r => r.status === 'rejected').length;

        logger.info('namer-labels', `Fetched ${labels.length}/${labelIds.length} labels (${failed} failed)`, {
            labelNames: labels.map(l => (l.properties as Record<string, unknown>)?.title || l.id),
        });

        return NextResponse.json({ labels });

    } catch (err: unknown) {
        return namerErrorResponse('namer-labels', err, 'Fetching Drive labels');
    }
}
