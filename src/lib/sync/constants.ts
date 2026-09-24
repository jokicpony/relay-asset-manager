/**
 * Shared sync pipeline constants.
 *
 * No app-alias imports here: scripts import this module by relative path
 * under tsx, same as src/lib/filename-utils.
 */

/**
 * Days a soft-deleted asset stays in the trash before the sync hard-deletes
 * it. The Trash UI countdown derives from this too — keep them in lockstep.
 * ('out-of-scope' assets are exempt from the purge entirely.)
 */
export const PURGE_AFTER_DAYS = 14;

/**
 * Days a shortcut row survives after a sync stops seeing it in Drive
 * (shortcuts.missing_since). Long enough to ride out transient Drive
 * listing anomalies across several 6-hourly sync runs; short enough that a
 * genuinely deleted shortcut's relay badge doesn't linger for long.
 */
export const SHORTCUT_GRACE_DAYS = 2;
