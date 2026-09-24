import type { SupabaseClient } from '@supabase/supabase-js';
import { buildEmbedText, type EmbeddableAssetRow } from '../embedding-text';

/**
 * Gemini embeddings — the one client used by the cron sync (re-embed step),
 * scripts/embed.ts (backfill), and the search route (query embeddings).
 *
 * Documents and queries MUST use the same model and dimensionality, or
 * search silently compares vectors from different spaces; both live here.
 *
 * No app-alias imports: scripts import this module by relative path.
 */

export const EMBED_MODEL = 'gemini-embedding-2-preview';
export const EMBED_DIMENSIONS = 768;
const API_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}`;

type EmbedPart = { text: string } | { inline_data: { mime_type: string; data: string } };

export type EmbeddableAsset = EmbeddableAssetRow & {
    id: string;
    drive_file_id: string;
    thumbnail_url: string | null;
    /** Row version when read — writeEmbeddings skips rows changed since */
    updated_at?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const request = (parts: EmbedPart[]) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts },
    outputDimensionality: EMBED_DIMENSIONS,
});

class RetryableEmbedError extends Error {}

/** One batchEmbedContents call, retrying 429 and 5xx with backoff. */
async function batchEmbed(apiKey: string, requests: ReturnType<typeof request>[]): Promise<number[][]> {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(`${API_BASE}:batchEmbedContents`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({ requests }),
            });
        } catch (err) {
            // Network failure: retryable — per-asset retries would hit the same outage
            if (attempt >= MAX_ATTEMPTS) throw new RetryableEmbedError(`Gemini unreachable: ${err instanceof Error ? err.message : err}`);
            await sleep(2000 * attempt);
            continue;
        }
        if (res.ok) {
            const data = await res.json() as { embeddings: { values: number[] }[] };
            return data.embeddings.map((e) => e.values);
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
            const text = await res.text().catch(() => '');
            const Err = retryable ? RetryableEmbedError : Error;
            throw new Err(`Gemini ${res.status}: ${text.slice(0, 200)}`);
        }
        await sleep((res.status === 429 ? 5000 : 2000) * 2 ** (attempt - 1));
    }
}

/** Embed a search query (text only — it matches image-augmented documents). */
export async function embedQuery(apiKey: string, text: string): Promise<number[]> {
    const res = await fetch(`${API_BASE}:embedContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(request([{ text }])),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const data = await res.json() as { embedding: { values: number[] } };
    return data.embedding.values;
}

/**
 * The asset's stored thumbnail as an image part (custom frame preferred), or
 * null. Gemini's embedding model only accepts JPEG and PNG, and stored
 * thumbnails are WebP — anything that isn't JPEG/PNG is converted to JPEG.
 * (Sending WebP labelled as JPEG failed the request and dropped the asset
 * to a text-only embedding.)
 */
async function thumbnailPart(supabase: SupabaseClient, asset: EmbeddableAsset): Promise<EmbedPart | null> {
    if (!asset.thumbnail_url || asset.thumbnail_url.includes('googleusercontent.com')) return null;

    for (const path of [`custom_${asset.drive_file_id}.webp`, `${asset.drive_file_id}.webp`]) {
        try {
            const { data, error } = await supabase.storage.from('thumbnails').download(path);
            if (error || !data) continue;
            let bytes: Buffer = Buffer.from(await data.arrayBuffer());
            const magic = bytes.subarray(0, 4).toString('hex');
            let mime = magic.startsWith('ffd8') ? 'image/jpeg' : magic.startsWith('89504e47') ? 'image/png' : null;
            if (!mime) {
                // Loaded lazily so the search route (embedQuery) never pulls in sharp
                const { default: sharp } = await import('sharp');
                bytes = await sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
                mime = 'image/jpeg';
            }
            return { inline_data: { mime_type: mime, data: bytes.toString('base64') } };
        } catch {
            // try the next path; text-only if none work
        }
    }
    return null;
}

export interface EmbedResult {
    /** asset id → vector */
    vectors: Map<string, number[]>;
    withImage: number;
    textOnly: number;
    /** asset ids that could not be embedded at all */
    failed: string[];
}

/**
 * Embed assets (text + thumbnail) in batches. A failed batch is retried per
 * asset, falling back to text-only for any asset whose image the API rejects.
 *
 * `onBatch` receives each batch's vectors as soon as they exist — callers
 * write them there (writeEmbeddings), so a crash or timeout late in a long
 * run keeps everything already embedded. If Gemini stays rate-limited or
 * unreachable through a batch's retries, the run stops and every remaining
 * asset is reported as failed (the next run picks them up).
 */
export async function embedAssets(
    supabase: SupabaseClient,
    apiKey: string,
    assets: EmbeddableAsset[],
    opts: {
        withImages?: boolean;
        log?: (message: string) => void;
        onBatch?: (vectors: Map<string, number[]>) => Promise<void>;
        onProgress?: (done: number, total: number, result: EmbedResult) => void;
    } = {},
): Promise<EmbedResult> {
    const { withImages = true, log = () => {} } = opts;
    const BATCH = 20;
    const result: EmbedResult = { vectors: new Map(), withImage: 0, textOnly: 0, failed: [] };

    const partsFor = async (asset: EmbeddableAsset) => {
        const text: EmbedPart = { text: buildEmbedText(asset) };
        const image = withImages ? await thumbnailPart(supabase, asset) : null;
        return { parts: image ? [text, image] : [text], hasImage: Boolean(image) };
    };

    for (let i = 0; i < assets.length; i += BATCH) {
        const batch = assets.slice(i, i + BATCH);
        const built = await Promise.all(batch.map(partsFor));
        const batchVectors = new Map<string, number[]>();

        try {
            const vectors = await batchEmbed(apiKey, built.map((b) => request(b.parts)));
            batch.forEach((asset, j) => {
                batchVectors.set(asset.id, vectors[j]);
                if (built[j].hasImage) result.withImage++; else result.textOnly++;
            });
        } catch (err) {
            if (err instanceof RetryableEmbedError) {
                // Quota exhausted or Gemini down through all retries — every
                // further batch would wait out the same backoff. Stop; the
                // remaining assets are picked up by the next run.
                log(`Embedding stopped at batch ${i / BATCH + 1}: ${err.message}`);
                result.failed.push(...assets.slice(i).map((a) => a.id));
                break;
            }
            // Usually one bad image — retry individually, text-only as a last resort
            log(`Embedding batch ${i / BATCH + 1} failed (${err instanceof Error ? err.message : err}) — retrying individually`);
            let quotaHit = false;
            for (const [j, asset] of batch.entries()) {
                try {
                    const [vec] = await batchEmbed(apiKey, [request(built[j].parts)]);
                    batchVectors.set(asset.id, vec);
                    if (built[j].hasImage) result.withImage++; else result.textOnly++;
                } catch (e1) {
                    if (e1 instanceof RetryableEmbedError) { quotaHit = true; }
                    else {
                        try {
                            const [vec] = await batchEmbed(apiKey, [request([{ text: buildEmbedText(asset) }])]);
                            batchVectors.set(asset.id, vec);
                            result.textOnly++;
                            log(`  ↳ ${asset.name}: text-only fallback`);
                            continue;
                        } catch (e2) {
                            if (e2 instanceof RetryableEmbedError) quotaHit = true;
                            else {
                                result.failed.push(asset.id);
                                log(`  ↳ ${asset.name}: failed — ${e2 instanceof Error ? e2.message : e2}`);
                                continue;
                            }
                        }
                    }
                    // Quota/outage hit mid-fallback: stop like the batch path does
                    log(`Embedding stopped during per-asset retries: Gemini rate-limited or unreachable`);
                    result.failed.push(...batch.slice(j).map((a) => a.id), ...assets.slice(i + BATCH).map((a) => a.id));
                    break;
                }
            }
            if (quotaHit) {
                for (const [id, vec] of batchVectors) result.vectors.set(id, vec);
                if (opts.onBatch && batchVectors.size > 0) await opts.onBatch(batchVectors);
                break;
            }
        }

        for (const [id, vec] of batchVectors) result.vectors.set(id, vec);
        if (opts.onBatch && batchVectors.size > 0) await opts.onBatch(batchVectors);
        opts.onProgress?.(Math.min(i + BATCH, assets.length), assets.length, result);
    }

    return result;
}

/**
 * Write vectors to assets.embedding (10 in flight). Returns ids that failed.
 *
 * With `versions` (id → updated_at as read), a write only lands if the row
 * is unchanged since: if an ingest renamed the asset and cleared its
 * embedding in the meantime, a vector built from the old text must not
 * overwrite that "needs embedding" marker. Such rows are counted as
 * `superseded` — they're picked up by the next run.
 */
export async function writeEmbeddings(
    supabase: SupabaseClient,
    vectors: Map<string, number[]>,
    versions?: Map<string, string | undefined>,
): Promise<{ written: number; failed: string[]; superseded: number }> {
    const entries = [...vectors];
    const failed: string[] = [];
    let written = 0;
    let superseded = 0;
    for (let i = 0; i < entries.length; i += 10) {
        const results = await Promise.all(entries.slice(i, i + 10).map(async ([id, vec]) => {
            let query = supabase.from('assets')
                .update({ embedding: JSON.stringify(vec) })
                .eq('id', id);
            const version = versions?.get(id);
            if (version) query = query.eq('updated_at', version);
            const { data, error } = await query.select('id');
            if (error) return 'failed' as const;
            return data && data.length > 0 ? 'written' as const : 'superseded' as const;
        }));
        results.forEach((r, j) => {
            if (r === 'written') written++;
            else if (r === 'superseded') superseded++;
            else failed.push(entries[i + j][0]);
        });
    }
    return { written, failed, superseded };
}
