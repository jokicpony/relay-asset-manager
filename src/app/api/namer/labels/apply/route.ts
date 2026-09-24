/**
 * Namer Label Apply API — Apply/modify labels on a Drive file.
 * Replaces client-side `driveService.applyLabel()`.
 *
 * POST body: {
 *   fileId: string,
 *   labelId: string,
 *   fieldValues: Record<string, { value: string | string[], type: string }>
 * }
 * Returns: modifyLabels response or { skipped: true }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDriveAccessToken } from '@/lib/google/auth';
import { isInSharedDrive } from '@/lib/google/drive-scope';
import { getConfig } from '@/lib/config';
import { createClient as createServerClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';
import { namerErrorResponse } from '@/lib/namer/route-errors';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

// Scope check (≤10s) + modifyLabels with retries (≤40s in total)
export const maxDuration = 60;
const APPLY_TIMEOUT_MS = 40_000;

async function applyLabelWithRetry(
    token: string,
    fileId: string,
    labelId: string,
    fieldValues: Record<string, { value: string | string[]; type: string }>,
    signal: AbortSignal,
    retriesLeft: number = MAX_RETRIES
): Promise<Response> {
    // Build field modifications
    const fieldModifications: Record<string, unknown>[] = [];

    for (const [fieldId, valObj] of Object.entries(fieldValues)) {
        const value = valObj?.value ?? valObj;
        const type = valObj?.type ?? 'text';

        if (!value || (Array.isArray(value) && value.length === 0)) continue;

        const mod: Record<string, unknown> = {
            fieldId,
            kind: 'drive#labelFieldModification',
        };

        switch (type) {
            case 'selection':
                mod.setSelectionValues = Array.isArray(value) ? value : [value];
                break;
            case 'integer':
                mod.setIntegerValues = [String(value)];
                break;
            case 'date':
                mod.setDateValues = [value];
                break;
            case 'user':
                mod.setUserValues = Array.isArray(value) ? value : [value];
                break;
            case 'text':
            default:
                mod.setTextValues = Array.isArray(value) ? value : [value];
                break;
        }

        fieldModifications.push(mod);
    }

    if (fieldModifications.length === 0) {
        logger.warn('namer-labels-apply', `SKIPPED label ${labelId} on ${fileId} — no field modifications built`, {
            rawFieldValues: JSON.stringify(fieldValues),
        });
        return new Response(JSON.stringify({ skipped: true, reason: 'no_fields' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const requestBody = {
        labelModifications: [{
            labelId,
            kind: 'drive#labelModification',
            fieldModifications,
        }],
    };

    logger.debug('namer-labels-apply', `Sending modifyLabels for file=${fileId} label=${labelId}`, {
        fieldModCount: fieldModifications.length,
        payload: JSON.stringify(requestBody),
    });

    const res = await fetch(`${DRIVE_API}/files/${fileId}/modifyLabels`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal,
    });

    // Retry on transient errors (the shared deadline still bounds the loop)
    if (!res.ok && retriesLeft > 0 && !signal.aborted && (res.status === 403 || res.status === 429)) {
        const retryBody = await res.text();
        logger.warn('namer-labels-apply', `Retry applyLabel ${labelId} on ${fileId} (${retriesLeft - 1} left) status=${res.status}`, {
            errorBody: retryBody,
        });
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        return applyLabelWithRetry(token, fileId, labelId, fieldValues, signal, retriesLeft - 1);
    }

    return res;
}

export async function POST(request: NextRequest) {
    const supabase = await createServerClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { fileId, labelId, fieldValues } = body;

        logger.debug('namer-labels-apply', `Request: file=${fileId} label=${labelId}`, {
            fieldValueKeys: Object.keys(fieldValues || {}),
        });

        if (!fileId || !labelId) {
            return NextResponse.json({ error: 'fileId and labelId are required' }, { status: 400 });
        }

        const token = await getDriveAccessToken();

        // Bound the namer to the configured shared drive (see drive-scope).
        const { sharedDriveId } = await getConfig();
        if (!(await isInSharedDrive(token, fileId, sharedDriveId))) {
            return NextResponse.json({ error: 'File is outside the configured shared drive' }, { status: 403 });
        }

        const res = await applyLabelWithRetry(
            token, fileId, labelId, fieldValues || {}, AbortSignal.timeout(APPLY_TIMEOUT_MS)
        );

        if (!res.ok) {
            const errBody = await res.text();
            logger.error('namer-labels-apply', `FAILED label ${labelId} on ${fileId} (status ${res.status})`, { error: errBody });
            return NextResponse.json(
                { error: `Drive API error: ${res.status}`, details: errBody },
                { status: res.status }
            );
        }

        const result = await res.json();
        logger.info('namer-labels-apply', `SUCCESS label ${labelId} on ${fileId}`);
        return NextResponse.json(result);

    } catch (err: unknown) {
        return namerErrorResponse('namer-labels-apply', err, 'Applying the Drive label');
    }
}
