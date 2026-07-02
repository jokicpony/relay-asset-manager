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
