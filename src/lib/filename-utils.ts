/**
 * Filename parser for the Relay Asset Manager.
 *
 * Convention 1 (date-first):  YYYYMMDD_CreatorName_ShootDescription_SequenceNumber.ext
 * Convention 2 (brand-first): $Brand_ContentDesc_MoreDesc_$Category_$Tag_Sequence.ext
 *
 * Rules (Convention 1):
 *   - Underscores separate tokens
 *   - Hyphens represent spaces within a token
 *   - First token is always an 8-digit date
 *   - Second token is always the creator name
 *   - Last token (before extension) is always a numeric sequence
 *   - Everything in between is the shoot/project description
 *
 * Rules (Convention 2 — fallback):
 *   - First $-prefixed token → brand / creator
 *   - Non-$ tokens (excluding trailing sequence) → shoot description
 *   - Additional $-prefixed tokens → category/variant tags
 *   - Last purely-numeric token → sequence number
 *
 * Future: Drive Label fields will take priority over parsed values.
 */

export interface ParsedFilename {
    /** Shoot date as a Date, or null if the first token isn't a valid date */
    shootDate: Date | null;
    /** Creator name with hyphens converted to spaces */
    creator: string | null;
    /** Shoot description tokens joined with ' / ', hyphens converted to spaces */
    shootDescription: string | null;
    /** Sequence number string (e.g., "001", "014") */
    sequence: string | null;
    /** Whether the filename matched the expected convention */
    parsed: boolean;
    /** Tags extracted from $-prefixed tokens (brand-first convention only) */
    tags: string[];
}

/**
 * Parse an asset filename into structured metadata fields.
 *
 * @example
 * parseFilename('20260205_Tatianna-Repstock_Tailgate_Firelight-Flask_010.jpg')
 * // => {
 * //   shootDate: Date('2026-02-05'),
 * //   creator: 'Tatianna Repstock',
 * //   shootDescription: 'Tailgate / Firelight Flask',
 * //   sequence: '010',
 * //   parsed: true,
 * //   tags: [],
 * // }
 *
 * @example
 * parseFilename('$Torch_BirdieCelebration_Golf-Background_$Flex_$Experience_$darkroast_1.mp4')
 * // => {
 * //   shootDate: null,
 * //   creator: 'Torch',
 * //   shootDescription: 'Birdie Celebration / Golf Background',
 * //   sequence: '1',
 * //   parsed: true,
 * //   tags: ['Flex', 'Experience', 'darkroast'],
 * // }
 */
export function parseFilename(filename: string): ParsedFilename {
    // Strip extension
    const baseName = filename.replace(/\.[^.]+$/, '');
    const tokens = baseName.split('_').filter(t => t.length > 0); // filter handles double underscores

    // Need at least 2 tokens
    if (tokens.length < 2) {
        return { shootDate: null, creator: null, shootDescription: null, sequence: null, parsed: false, tags: [] };
    }

    // ── Convention 1: Date-first (YYYYMMDD_Creator_Description_Seq) ──
    const dateToken = tokens[0];
    if (/^\d{8}$/.test(dateToken)) {
        return parseDateFirst(tokens, dateToken);
    }

    // ── Convention 2: Brand-first ($Brand_Desc_$Tag_Seq) ──
    if (tokens[0].startsWith('$')) {
        return parseBrandFirst(tokens);
    }

    // ── Fallback: generic underscore-delimited ──
    return parseGeneric(tokens);
}

// ---------------------------------------------------------------------------
// Convention 1: Date-first
// ---------------------------------------------------------------------------
function parseDateFirst(tokens: string[], dateToken: string): ParsedFilename {
    const year = parseInt(dateToken.substring(0, 4), 10);
    const month = parseInt(dateToken.substring(4, 6), 10) - 1;
    const day = parseInt(dateToken.substring(6, 8), 10);
    const shootDate = new Date(year, month, day);

    const creatorToken = tokens[1];
    const creator = creatorToken.replace(/-/g, ' ');

    const lastToken = tokens[tokens.length - 1];
    const isSequence = /^\d+$/.test(lastToken);
    const sequence = isSequence ? lastToken : null;

    const descStart = 2;
    const descEnd = isSequence ? tokens.length - 1 : tokens.length;
    const descTokens = tokens.slice(descStart, descEnd);
    const shootDescription =
        descTokens.length > 0
            ? descTokens.map((t) => t.replace(/-/g, ' ')).join(' / ')
            : null;

    return { shootDate, creator, shootDescription, sequence, parsed: true, tags: [] };
}

// ---------------------------------------------------------------------------
// Convention 2: Brand/Dollar-sign-first ($Brand_Desc_$Tag_Seq)
// ---------------------------------------------------------------------------
function parseBrandFirst(tokens: string[]): ParsedFilename {
    // First $-prefixed token → creator / brand (strip $)
    const creator = tokens[0].substring(1).replace(/-/g, ' ');

    // Last token → sequence number if purely numeric
    const lastToken = tokens[tokens.length - 1];
    const isSequence = /^\d+$/.test(lastToken);
    const sequence = isSequence ? lastToken : null;

    // Process remaining tokens (skip first brand, skip trailing sequence)
    const remaining = tokens.slice(1, isSequence ? tokens.length - 1 : tokens.length);

    const descParts: string[] = [];
    const tags: string[] = [];

    for (const token of remaining) {
        if (token.startsWith('$')) {
            // $-prefixed → tag (strip $, keep original casing)
            tags.push(token.substring(1).replace(/-/g, ' '));
        } else {
            // Plain token → description segment
            descParts.push(token.replace(/-/g, ' '));
        }
    }

    const shootDescription = descParts.length > 0 ? descParts.join(' / ') : null;

    return { shootDate: null, creator, shootDescription, sequence, parsed: true, tags };
}

// ---------------------------------------------------------------------------
// Fallback: generic underscore-delimited (no date, no $ prefix)
// ---------------------------------------------------------------------------
function parseGeneric(tokens: string[]): ParsedFilename {
    const lastToken = tokens[tokens.length - 1];
    const isSequence = /^\d+$/.test(lastToken);
    const sequence = isSequence ? lastToken : null;

    const descTokens = tokens.slice(0, isSequence ? tokens.length - 1 : tokens.length);
    const shootDescription =
        descTokens.length > 0
            ? descTokens.map((t) => t.replace(/-/g, ' ')).join(' / ')
            : null;

    return { shootDate: null, creator: null, shootDescription, sequence, parsed: false, tags: [] };
}

/**
 * Resolve the display creator for an asset.
 * Priority: explicit creator field (Drive Label) → parsed from filename.
 */
export function resolveCreator(asset: { name: string; creator?: string | null }): string | null {
    if (asset.creator) return asset.creator;
    const parsed = parseFilename(asset.name);
    return parsed.creator;
}

/**
 * Resolve the shoot date for an asset.
 */
export function resolveShootDate(asset: { name: string }): Date | null {
    return parseFilename(asset.name).shootDate;
}
