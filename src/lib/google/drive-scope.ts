const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/**
 * Verify a Drive resource (file or folder) lives inside the configured shared
 * drive. The service account may have access to other drives, or to files
 * shared with it directly; the namer must not be usable to read or mutate
 * anything outside the DAM's shared drive.
 *
 * Fails closed (returns false) if the resource can't be read. When no shared
 * drive is configured, imposes no restriction (matches existing fallbacks).
 */
export async function isInSharedDrive(
    token: string,
    resourceId: string,
    sharedDriveId: string,
): Promise<boolean> {
    if (!sharedDriveId) return true;                 // not configured → no restriction
    if (resourceId === sharedDriveId) return true;   // the shared drive root itself

    const res = await fetch(
        `${DRIVE_API}/files/${encodeURIComponent(resourceId)}?fields=id,driveId&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return false;                        // can't verify → deny

    const data = (await res.json()) as { driveId?: string };
    return data.driveId === sharedDriveId;
}
