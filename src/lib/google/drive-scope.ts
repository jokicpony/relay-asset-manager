import { fetchWithDriveRetry } from '@/lib/sync/drive-retry';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/** Total budget for the check, including retry backoff (~3s at 2 retries). */
const SCOPE_CHECK_TIMEOUT_MS = 10_000;
const SCOPE_CHECK_RETRIES = 2;

/**
 * Drive couldn't answer the scope check (rate limit, 5xx, timeout, network).
 * Not a verdict — routes should answer 503 "try again", not 403 "outside the
 * shared drive". See scopeUnavailableResponse in src/lib/namer/route-errors.ts.
 */
export class DriveScopeUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DriveScopeUnavailableError';
    }
}

/**
 * Verify a Drive resource (file or folder) lives inside the configured shared
 * drive. The service account may have access to other drives, or to files
 * shared with it directly; the namer must not be usable to read or mutate
 * anything outside the DAM's shared drive.
 *
 * Fails closed (returns false) when Drive says the resource can't be read
 * (403/404/other 4xx). Transient failures — 429, 403 rate-limit, 5xx, timeout
 * — are retried briefly and then throw DriveScopeUnavailableError, so callers
 * don't report a real in-drive file as "outside the shared drive".
 * When no shared drive is configured, imposes no restriction (matches
 * existing fallbacks).
 */
export async function isInSharedDrive(
    token: string,
    resourceId: string,
    sharedDriveId: string,
): Promise<boolean> {
    if (!sharedDriveId) return true;                 // not configured → no restriction
    if (resourceId === sharedDriveId) return true;   // the shared drive root itself

    let res: Response;
    try {
        res = await fetchWithDriveRetry(
            `${DRIVE_API}/files/${encodeURIComponent(resourceId)}?fields=id,driveId&supportsAllDrives=true`,
            {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(SCOPE_CHECK_TIMEOUT_MS),
            },
            SCOPE_CHECK_RETRIES,
        );
    } catch (err) {
        const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
        throw new DriveScopeUnavailableError(`Google Drive check ${reason} — try again in a moment`);
    }

    if (!res.ok) {
        if (res.status === 429 || res.status >= 500 || (res.status === 403 && await isRateLimitBody(res))) {
            throw new DriveScopeUnavailableError(
                `Google Drive is busy (HTTP ${res.status}) — try again in a moment`
            );
        }
        return false;                                 // can't verify → deny
    }

    const data = (await res.json()) as { driveId?: string };
    return data.driveId === sharedDriveId;
}

/** Drive reports quota exhaustion as a 403 with a rate-limit reason. */
async function isRateLimitBody(res: Response): Promise<boolean> {
    const body = await res.json().catch(() => null) as
        { error?: { errors?: { reason?: string }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? '';
    return reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded';
}
