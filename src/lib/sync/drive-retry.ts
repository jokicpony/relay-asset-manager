/**
 * Retry helpers for Google Drive API calls, shared by the cron sync and the
 * in-app routes.
 *
 * Drive signals quota exhaustion as 429 *or* 403 with a rate-limit reason;
 * the googleapis client's built-in retry only covers 429/5xx, and raw fetch()
 * calls have none. Both helpers back off exponentially with jitter.
 *
 * No app-alias imports: scripts import this module by relative path.
 */

const DEFAULT_MAX_RETRIES = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => 2 ** attempt * 1000 + Math.random() * 500;

/** True for Drive's rate-limit / quota errors (googleapis error objects). */
export function isDriveRateLimitError(rawErr: unknown): boolean {
    // Google API errors are untyped — narrow to the fields we inspect
    const err = rawErr as {
        code?: number;
        status?: number;
        message?: string;
        response?: { status?: number };
        errors?: { reason?: string }[];
    } | null;
    const status = err?.code ?? err?.response?.status ?? err?.status;
    const reason = err?.errors?.[0]?.reason ?? '';
    const message = err?.message ?? '';
    return status === 429
        || (status === 403 && (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded'))
        || message.includes('User rate limit exceeded')
        || message.includes('Rate limit exceeded');
}

/**
 * Run a googleapis call, retrying rate-limit errors with backoff.
 * `onRetry` lets the caller log (the sync prints progress; routes use logger).
 */
export async function withDriveRetry<T>(
    fn: () => Promise<T>,
    label: string,
    onRetry?: (message: string) => void,
    maxRetries = DEFAULT_MAX_RETRIES,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isDriveRateLimitError(err) || attempt >= maxRetries) throw err;
            const wait = backoffMs(attempt);
            onRetry?.(`Rate limited on ${label} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${(wait / 1000).toFixed(1)}s`);
            await sleep(wait);
        }
    }
}

/**
 * fetch() against the Drive API with the same policy: retries 429, 403
 * rate-limit responses and 5xx; returns the final Response either way (the
 * caller decides what a non-OK status means). Callers inside a time budget
 * (Vercel routes, per-thumbnail fetches) should pass a small `maxRetries`:
 * the default five with exponential backoff can wait ~30s.
 */
export async function fetchWithDriveRetry(
    url: string,
    init?: RequestInit,
    maxRetries = DEFAULT_MAX_RETRIES,
): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, init);
        if (res.ok || attempt >= maxRetries) return res;

        let retryable = res.status === 429 || res.status >= 500;
        if (res.status === 403) {
            const body = await res.clone().json().catch(() => null) as
                { error?: { errors?: { reason?: string }[] } } | null;
            const reason = body?.error?.errors?.[0]?.reason ?? '';
            retryable = reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded';
        }
        if (!retryable) return res;
        await sleep(backoffMs(attempt));
    }
}
