/**
 * Pure naming helpers for the Asset Namer: building a proposed name from the
 * schema fields, and resolving collisions with names already in the
 * destination folder.
 *
 * Collisions matter beyond tidiness: parseFilename (src/lib/filename-utils.ts)
 * reads the last purely-numeric token as the sequence. A `_v2` suffix after
 * the counter (`…_001_v2.jpg`) leaves no trailing sequence, and "001 / v2"
 * leaks into the parsed description and the search embedding. So a collision
 * on a counter-bearing name bumps the counter instead.
 */

import type { SchemaField } from './types';
import { sanitizeNameToken } from './name-token';

/** Counter tokens are zero-padded to three digits (001, 002, …, 1000). */
export function formatCounter(num: number): string {
    return String(num).padStart(3, '0');
}

/** Split `name.ext` into [`name`, `.ext`] (extension empty when there is none). */
export function splitExtension(name: string): [string, string] {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? [name, ''] : [name.substring(0, dot), name.substring(dot)];
}

/** The `_`-delimited tokens a schema emits, with the counter as a placeholder. */
function schemaTokens(fields: SchemaField[]): (string | { counter: true })[] {
    const tokens: (string | { counter: true })[] = [];
    for (const field of fields) {
        if (field.type === 'counter') {
            tokens.push({ counter: true });
        } else {
            // Text/select/date, and constants (fixed tokens from Settings).
            // Skip values that sanitize to nothing, or the name gets "__".
            const token = field.value ? sanitizeNameToken(field.value) : '';
            if (token) tokens.push(token);
        }
    }
    return tokens;
}

/**
 * Build the proposed name for one file. `counterNum` is the counter value for
 * this file (start + its index among pending files). Falls back to the
 * original name when the schema emits nothing.
 */
export function buildProposedName(fields: SchemaField[], originalName: string, counterNum: number): string {
    const tokens = schemaTokens(fields);
    if (tokens.length === 0) return originalName;
    const [, ext] = splitExtension(originalName);
    return tokens.map(t => typeof t === 'string' ? t : formatCounter(counterNum)).join('_') + ext;
}

/**
 * Index of the counter among the name's `_` tokens, or null when the schema
 * has no counter. Tokens never contain `_` (sanitizeNameToken), so the index
 * is stable for every name built from the same fields.
 */
export function counterTokenIndex(fields: SchemaField[]): number | null {
    const idx = schemaTokens(fields).findIndex(t => typeof t !== 'string');
    return idx === -1 ? null : idx;
}

/**
 * Resolve a collision for a single name. When `counterIndex` points at a
 * numeric token, the counter is incremented (keeping its padding) until the
 * name is free: `…_001.jpg` → `…_002.jpg`. Otherwise — no counter, e.g. a
 * passthrough camera name like IMG_0001 whose digits aren't ours to change —
 * `_v2`, `_v3`, … is appended.
 */
export function dedupeName(
    name: string,
    isTaken: (candidate: string) => boolean,
    counterIndex: number | null = null,
): string {
    if (!isTaken(name)) return name;
    const [base, ext] = splitExtension(name);

    if (counterIndex !== null) {
        const tokens = base.split('_');
        const digits = tokens[counterIndex];
        if (digits !== undefined && /^\d+$/.test(digits)) {
            for (let n = parseInt(digits, 10) + 1; ; n++) {
                tokens[counterIndex] = String(n).padStart(digits.length, '0');
                const candidate = tokens.join('_') + ext;
                if (!isTaken(candidate)) return candidate;
            }
        }
    }

    let version = 2;
    while (isTaken(`${base}_v${version}${ext}`)) version++;
    return `${base}_v${version}${ext}`;
}

/**
 * Lowest counter start ≥ `start` for which none of `count` sequential names
 * collides. `nameAt(num, i)` builds the i-th file's name with counter `num`.
 * Gives up after `maxTries` and returns `start` — the per-file dedupe in the
 * batch still prevents duplicates, just less tidily.
 */
export function findFreeCounterStart(
    start: number,
    count: number,
    nameAt: (num: number, i: number) => string,
    isTaken: (name: string) => boolean,
    maxTries = 10_000,
): number {
    if (count === 0) return start;
    // Names that don't depend on the counter can't be fixed by moving it
    if (nameAt(start, 0) === nameAt(start + 1, 0)) return start;
    for (let s = start; s < start + maxTries; s++) {
        let clear = true;
        for (let i = 0; i < count; i++) {
            if (isTaken(nameAt(s + i, i))) { clear = false; break; }
        }
        if (clear) return s;
    }
    return start;
}
