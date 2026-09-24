/**
 * Normalize one user-entered naming field into a filename token.
 *
 * Names are `_`-delimited and read back by parseFilename, so a value
 * containing `_` would split into extra tokens and shift the parsed creator
 * and description (which also feed the search embedding). Whitespace becomes
 * `-` (the long-standing behavior), `_` becomes `-`, and characters that
 * break filenames on common OSes are dropped.
 *
 * Shared by every place that shows or builds a name — the builder preview,
 * the confirm modal, and the batch itself — so what users see is what's
 * written.
 */
export function sanitizeNameToken(value: string): string {
    return value
        .trim()
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[\s_]+/g, '-');
}
