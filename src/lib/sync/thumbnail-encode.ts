import sharp from 'sharp';

/**
 * Normalize any downloaded thumbnail source into the stored format: a real
 * WebP, at most THUMBNAIL_MAX_PX on its longest side.
 *
 * Shared by both thumbnail paths (scripts/sync.ts and
 * src/lib/sync/thumbnail-processor.ts). Before this, both uploaded raw bytes
 * — usually Drive's JPEG, sometimes a full-resolution original when Drive
 * hadn't generated a thumbnailLink yet — under a .webp name with an
 * image/webp content type, so grid cards could pull multi-MB originals.
 *
 * Returns null when the bytes can't be decoded (e.g. HEIC, PSD, an HTML
 * error page): the caller should skip the upload so the next sync can retry
 * via thumbnailLink, rather than storing something browsers can't render.
 *
 * No app-alias imports here: scripts import this module by relative path.
 */
export const THUMBNAIL_MAX_PX = 800;

export async function encodeThumbnail(input: Buffer): Promise<Buffer | null> {
    try {
        return await sharp(input, { failOn: 'none' })
            .rotate() // honor EXIF orientation before metadata is stripped
            .resize(THUMBNAIL_MAX_PX, THUMBNAIL_MAX_PX, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
    } catch {
        return null;
    }
}
