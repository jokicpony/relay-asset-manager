/**
 * Builds the text half of a multimodal embedding input from an asset row.
 *
 * Single source of truth shared by scripts/sync.ts (re-embed step) and
 * scripts/embed.ts (batch backfill). Drift between the two would silently
 * degrade search quality: query vectors would match against differently
 * structured document text depending on which pipeline embedded the asset.
 */

export interface EmbeddableAssetRow {
    name: string;
    description: string | null;
    asset_type: string;
    folder_path: string;
    parsed_creator: string | null;
    parsed_shoot_description: string | null;
}

export function buildEmbedText(asset: EmbeddableAssetRow): string {
    const parts: string[] = [];

    // Filename (without extension, underscores → spaces)
    const baseName = asset.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    parts.push(baseName);

    if (asset.parsed_shoot_description) parts.push(asset.parsed_shoot_description);
    if (asset.parsed_creator) parts.push(`by ${asset.parsed_creator}`);
    parts.push(asset.asset_type);

    // Folder path segments (strip "1. " ordering prefixes)
    if (asset.folder_path && asset.folder_path !== '/') {
        const folders = asset.folder_path
            .split('/')
            .filter(Boolean)
            .map((f) => f.replace(/^\d+\.\s*/, ''))
            .join(' > ');
        parts.push(folders);
    }

    if (asset.description) parts.push(asset.description);

    return parts.join(' | ');
}

/** The stored columns an asset's embedding text is built from. */
export interface EmbedInputs {
    name: string;
    description: string | null;
    folder_path: string | null;
    parsed_creator: string | null;
    parsed_shoot_description: string | null;
}

/** Columns to select when checking embedding staleness (see embedInputsChanged). */
export const EMBED_INPUT_COLUMNS = 'name, description, folder_path, parsed_creator, parsed_shoot_description';

/**
 * Whether an asset's embedding is stale: any field buildEmbedText reads has
 * changed. (asset_type is fixed per file.) Used by the cron's re-embed step
 * and the in-app ingest — both must agree, or a change one path makes is
 * never re-embedded by the other.
 */
export function embedInputsChanged(before: EmbedInputs, after: EmbedInputs): boolean {
    return before.name !== after.name
        || (before.description ?? null) !== (after.description ?? null)
        || (before.folder_path ?? null) !== (after.folder_path ?? null)
        || (before.parsed_creator ?? null) !== (after.parsed_creator ?? null)
        || (before.parsed_shoot_description ?? null) !== (after.parsed_shoot_description ?? null);
}
