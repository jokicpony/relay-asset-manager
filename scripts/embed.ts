#!/usr/bin/env npx tsx
/**
 * Relay Asset Manager — Multimodal Embedding Script
 *
 * Usage:  npx tsx scripts/embed.ts
 *         npx tsx scripts/embed.ts --force    (re-embed all assets)
 *
 * Prerequisites:
 *   1. GEMINI_API_KEY set in .env.local
 *   2. Assets already synced to Supabase (run sync.ts first)
 *   3. Thumbnails uploaded to Supabase Storage (part of sync)
 *
 * This script:
 *   1. Fetches assets missing embeddings (or all with --force)
 *   2. Builds descriptive text strings from metadata
 *   3. Downloads thumbnail images from Supabase Storage
 *   4. Calls Gemini Embedding 2 (multimodal) in batches
 *   5. Updates the embedding column in Supabase
 *
 * The multimodal model embeds text + thumbnail image together,
 * producing a single vector that captures both visual and semantic content.
 * This enables cross-modal search: a text query like "campfire flask"
 * matches images that look like campfire flasks, not just metadata.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

const GEMINI_EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] ${msg}`);
}

function progress(current: number, total: number, label: string) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 2)) + '░'.repeat(50 - Math.round(pct / 2));
    process.stdout.write(`\r  ${bar} ${pct}% (${current}/${total}) ${label}`);
    if (current === total) process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Build embedding text from asset metadata
// ---------------------------------------------------------------------------
interface AssetRow {
    id: string;
    drive_file_id: string;
    name: string;
    description: string | null;
    asset_type: string;
    folder_path: string;
    parsed_creator: string | null;
    parsed_shoot_description: string | null;
    organic_rights: string | null;
    paid_rights: string | null;
    thumbnail_url: string | null;
}

function buildEmbeddingText(asset: AssetRow): string {
    const parts: string[] = [];

    // Filename (without extension)
    const baseName = asset.name.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    parts.push(baseName);

    // Parsed description (e.g., "Tailgate Upgrade Firelight")
    if (asset.parsed_shoot_description) {
        parts.push(asset.parsed_shoot_description);
    }

    // Creator
    if (asset.parsed_creator) {
        parts.push(`by ${asset.parsed_creator}`);
    }

    // Asset type
    parts.push(asset.asset_type);

    // Folder path segments (cleaned up)
    if (asset.folder_path && asset.folder_path !== '/') {
        const folders = asset.folder_path
            .split('/')
            .filter(Boolean)
            .map((f) => f.replace(/^\d+\.\s*/, '')) // strip "1. " prefixes
            .join(' > ');
        parts.push(folders);
    }

    // Drive description if available
    if (asset.description) {
        parts.push(asset.description);
    }

    return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Download thumbnail from Supabase Storage as base64
// ---------------------------------------------------------------------------
/**
 * Detect actual image format from magic bytes.
 * Thumbnails are stored as .webp but may contain JPEG/PNG data.
 * Gemini Embedding 2 only accepts image/jpeg and image/png.
 */
function detectMimeType(buffer: Buffer): string {
    const hex = buffer.slice(0, 4).toString('hex');
    if (hex.startsWith('ffd8')) return 'image/jpeg';
    if (hex.startsWith('8950')) return 'image/png';
    // WebP files start with RIFF header — Gemini doesn't accept these,
    // but we can try sending as JPEG as a fallback (the API may still decode it)
    return 'image/jpeg';
}

async function downloadThumbnailBase64(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    driveFileId: string,
    thumbnailUrl: string | null
): Promise<{ base64: string; mimeType: string } | null> {
    if (!thumbnailUrl) return null;

    // Try custom thumbnail first, then standard
    const paths = [
        `custom_${driveFileId}.webp`,
        `${driveFileId}.webp`,
    ];

    for (const filePath of paths) {
        try {
            const { data, error } = await supabase.storage
                .from('thumbnails')
                .download(filePath);

            if (error || !data) continue;

            const arrayBuffer = await data.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const base64 = buffer.toString('base64');
            const mimeType = detectMimeType(buffer);
            return { base64, mimeType };
        } catch {
            continue;
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Build a multimodal embedding request (text + optional image)
// ---------------------------------------------------------------------------
interface EmbedPart {
    text?: string;
    inline_data?: { mime_type: string; data: string };
}

function buildEmbedRequest(text: string, thumbnail: { base64: string; mimeType: string } | null) {
    const parts: EmbedPart[] = [{ text }];

    if (thumbnail) {
        parts.push({
            inline_data: {
                mime_type: thumbnail.mimeType,
                data: thumbnail.base64,
            },
        });
    }

    return {
        model: 'models/gemini-embedding-2-preview',
        content: { parts },
        outputDimensionality: 768,
    };
}

// ---------------------------------------------------------------------------
// Call Gemini batch embed API (multimodal)
// ---------------------------------------------------------------------------
async function batchEmbed(
    requests: ReturnType<typeof buildEmbedRequest>[]
): Promise<number[][]> {
    const res = await fetch(`${GEMINI_EMBED_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    return data.embeddings.map((e: any) => e.values);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    const forceAll = args.includes('--force');
    const textOnly = args.includes('--text-only'); // Fallback: skip thumbnail download

    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   Relay Asset Manager — Multimodal Embed Assets     ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    // Validate config
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new Error('Missing Supabase config in .env.local');
    }
    if (!GEMINI_API_KEY) {
        throw new Error(
            'Missing GEMINI_API_KEY in .env.local\n' +
            '  Get a free API key at: https://aistudio.google.com/apikey'
        );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const startTime = Date.now();

    log(`🧠 Model: gemini-embedding-2-preview (multimodal)`);
    log(`📐 Dimensions: 768 (Matryoshka)`);
    if (textOnly) log(`⚠️  Text-only mode — skipping thumbnail images`);

    // Fetch assets needing embeddings
    log(forceAll ? '🔄 Force mode — re-embedding ALL assets' : '🔍 Finding assets without embeddings...');

    // Fetch in pages (Supabase limit is 1000 per query)
    const allAssets: AssetRow[] = [];
    const PAGE_SIZE = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        let query = supabase
            .from('assets')
            .select('id, drive_file_id, name, description, asset_type, folder_path, parsed_creator, parsed_shoot_description, organic_rights, paid_rights, thumbnail_url')
            .eq('is_active', true)
            .order('id')
            .range(offset, offset + PAGE_SIZE - 1);

        if (!forceAll) {
            query = query.is('embedding', null);
        }

        const { data, error } = await query;
        if (error) throw new Error(`Supabase query failed: ${error.message}`);

        allAssets.push(...(data as AssetRow[]));
        hasMore = data.length === PAGE_SIZE;
        offset += PAGE_SIZE;
    }

    if (allAssets.length === 0) {
        log('✅ All assets already have embeddings! Nothing to do.');
        return;
    }

    log(`  Found ${allAssets.length} assets to embed`);

    // Count assets with thumbnails for reporting
    const withThumbnails = allAssets.filter(a => a.thumbnail_url && !a.thumbnail_url.includes('googleusercontent.com')).length;
    log(`  📷 ${withThumbnails} have thumbnails available for multimodal embedding`);
    log(`  📝 ${allAssets.length - withThumbnails} will use text-only embedding (no thumbnail)`);

    // Process in batches of 20 (smaller than before due to larger payloads with images)
    const BATCH_SIZE = 20;
    let embedded = 0;
    let withImage = 0;
    let textOnlyCount = 0;
    let errors = 0;

    for (let i = 0; i < allAssets.length; i += BATCH_SIZE) {
        const batch = allAssets.slice(i, i + BATCH_SIZE);

        try {
            // Build multimodal requests: text + thumbnail for each asset
            const requests = await Promise.all(
                batch.map(async (asset) => {
                    const text = buildEmbeddingText(asset);

                    let thumbnail: { base64: string; mimeType: string } | null = null;
                    if (!textOnly && asset.thumbnail_url && !asset.thumbnail_url.includes('googleusercontent.com')) {
                        thumbnail = await downloadThumbnailBase64(supabase, asset.drive_file_id, asset.thumbnail_url);
                    }

                    if (thumbnail) {
                        withImage++;
                    } else {
                        textOnlyCount++;
                    }

                    return buildEmbedRequest(text, thumbnail);
                })
            );

            const embeddings = await batchEmbed(requests);

            // Update assets with embeddings in parallel (groups of 10)
            const UPDATE_CONCURRENCY = 10;
            for (let j = 0; j < batch.length; j += UPDATE_CONCURRENCY) {
                const updateBatch = batch.slice(j, j + UPDATE_CONCURRENCY);
                const results = await Promise.allSettled(
                    updateBatch.map((asset, idx) =>
                        supabase
                            .from('assets')
                            .update({ embedding: JSON.stringify(embeddings[j + idx]) })
                            .eq('id', asset.id)
                    )
                );
                for (const result of results) {
                    if (result.status === 'fulfilled' && !result.value.error) {
                        embedded++;
                    } else {
                        errors++;
                    }
                }
            }
        } catch (err: any) {
            // Rate limit — back off and retry the whole batch
            if (err.message.includes('429')) {
                log('\n  ⏳ Rate limited — waiting 30s...');
                await sleep(30000);
                i -= BATCH_SIZE; // retry this batch
                // Reset image/text counters for retried batch
                withImage -= batch.filter(a => a.thumbnail_url && !a.thumbnail_url.includes('googleusercontent.com')).length;
                textOnlyCount -= batch.filter(a => !a.thumbnail_url || a.thumbnail_url.includes('googleusercontent.com')).length;
                continue;
            }

            // Batch failed (likely a bad thumbnail) — retry each asset individually
            log(`\n  ⚠️  Batch failed, retrying ${batch.length} assets individually...`);
            for (const asset of batch) {
                try {
                    const text = buildEmbeddingText(asset);
                    let thumbnail: { base64: string; mimeType: string } | null = null;
                    if (!textOnly && asset.thumbnail_url && !asset.thumbnail_url.includes('googleusercontent.com')) {
                        thumbnail = await downloadThumbnailBase64(supabase, asset.drive_file_id, asset.thumbnail_url);
                    }

                    let req = buildEmbedRequest(text, thumbnail);
                    let singleRes = await batchEmbed([req]);

                    // If multimodal fails, fall back to text-only
                    if (!singleRes || singleRes.length === 0) throw new Error('Empty response');

                    const { error: updateErr } = await supabase
                        .from('assets')
                        .update({ embedding: JSON.stringify(singleRes[0]) })
                        .eq('id', asset.id);
                    if (!updateErr) {
                        embedded++;
                        if (thumbnail) withImage++; else textOnlyCount++;
                    } else {
                        errors++;
                    }
                } catch {
                    // Multimodal failed for this asset — try text-only
                    try {
                        const text = buildEmbeddingText(asset);
                        const textReq = buildEmbedRequest(text, null);
                        const textRes = await batchEmbed([textReq]);
                        if (textRes && textRes.length > 0) {
                            const { error: updateErr } = await supabase
                                .from('assets')
                                .update({ embedding: JSON.stringify(textRes[0]) })
                                .eq('id', asset.id);
                            if (!updateErr) {
                                embedded++;
                                textOnlyCount++;
                                log(`    ↳ ${asset.name}: text-only fallback ✓`);
                            } else {
                                errors++;
                            }
                        }
                    } catch (e2: any) {
                        errors++;
                        log(`    ↳ ${asset.name}: failed entirely — ${e2.message}`);
                    }
                }
                await sleep(200); // Small delay between individual retries
            }
        }

        progress(Math.min(i + BATCH_SIZE, allAssets.length), allAssets.length, 'embedded');

        // Small delay between batches to stay under rate limits
        if (i + BATCH_SIZE < allAssets.length) {
            await sleep(500);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    log(`🎉 Embedding complete! ${embedded} assets embedded, ${errors} errors in ${elapsed}s`);
    log(`   📷 ${withImage} with thumbnail (multimodal)`);
    log(`   📝 ${textOnlyCount} text-only (no thumbnail available)`);
    console.log('');
}

main().catch((err) => {
    console.error('');
    console.error('❌ Embedding failed:', err.message);
    process.exit(1);
});
