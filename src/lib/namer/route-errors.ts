/**
 * Server-only helpers for the /api/namer/* routes: request timeouts and the
 * catch-all error response. Not imported by client code.
 *
 * Timeouts are sized to fit each route's `maxDuration`; a route that makes
 * several sequential calls budgets them so the sum stays under it and the
 * user gets "timed out" from us rather than an opaque platform 504.
 */

import { NextResponse } from 'next/server';
import { DriveScopeUnavailableError } from '@/lib/google/drive-scope';
import { logger } from '@/lib/logger';

/** One Drive metadata call (PATCH / GET metadata / one list page). */
export const DRIVE_CALL_TIMEOUT_MS = 15_000;

/** fetch() rejects with this name when an AbortSignal.timeout() fires. */
export function isTimeoutError(err: unknown): boolean {
    return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/**
 * Map an unexpected route error to a response: scope-check outages → 503,
 * timeouts → 504 (both retryable, with a sentence the queue can show), the
 * rest → 500. `what` names the operation for the timeout message.
 */
export function namerErrorResponse(scope: string, err: unknown, what: string): NextResponse {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DriveScopeUnavailableError) {
        logger.warn(scope, 'Shared-drive scope check unavailable', { error: message });
        return NextResponse.json({ error: message }, { status: 503 });
    }
    if (isTimeoutError(err)) {
        logger.warn(scope, `${what} timed out`);
        return NextResponse.json({ error: `${what} timed out — try again` }, { status: 504 });
    }
    logger.error(scope, 'Unexpected error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
}
