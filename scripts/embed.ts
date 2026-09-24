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
import { embedAssets, writeEmbeddings, EMBED_MODEL, EMBED_DIMENSIONS, type EmbeddableAsset } from '../src/lib/sync/embedder';

// ---------------------------------------------------------------------------
// Load environment
// ---------------------------------------------------------------------------
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

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
// Main — batching, retries, image handling and the Gemini call itself live
// in the shared embedder (src/lib/sync/embedder), same as the sync's
// re-embed step.
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

    log(`🧠 Model: ${EMBED_MODEL} (multimodal)`);
    log(`📐 Dimensions: ${EMBED_DIMENSIONS} (Matryoshka)`);
    if (textOnly) log(`⚠️  Text-only mode — skipping thumbnail images`);
    log(forceAll ? '🔄 Force mode — re-embedding ALL assets' : '🔍 Finding assets without embeddings...');

    // Fetch in pages (PostgREST caps a select at 1000 rows)
    const allAssets: EmbeddableAsset[] = [];
    for (let from = 0; ; from += 1000) {
        let query = supabase
            .from('assets')
            .select('id, drive_file_id, name, description, asset_type, folder_path, parsed_creator, parsed_shoot_description, thumbnail_url, updated_at')
            .eq('is_active', true)
            .order('id')
            .range(from, from + 999);
        if (!forceAll) query = query.is('embedding', null);

        const { data, error } = await query;
        if (error) throw new Error(`Supabase query failed: ${error.message}`);
        allAssets.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }

    if (allAssets.length === 0) {
        log('✅ All assets already have embeddings! Nothing to do.');
        return;
    }
    log(`  Found ${allAssets.length} assets to embed`);

    // Each batch is written as soon as it's embedded — an interrupted run
    // keeps its progress, and a re-run only picks up what's left.
    let written = 0;
    const writeFailed: string[] = [];
    const versions = new Map(allAssets.map(a => [a.id, a.updated_at]));
    const result = await embedAssets(supabase, GEMINI_API_KEY, allAssets, {
        withImages: !textOnly,
        log: (m) => log(`  ⚠️  ${m}`),
        onBatch: async (vectors) => {
            const w = await writeEmbeddings(supabase, vectors, versions);
            written += w.written;
            writeFailed.push(...w.failed);
        },
        onProgress: (done, total) => progress(done, total, 'embedded'),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('');
    log(`🎉 Embedding complete! ${written} assets embedded, ${result.failed.length + writeFailed.length} errors in ${elapsed}s`);
    log(`   📷 ${result.withImage} with thumbnail (multimodal)`);
    log(`   📝 ${result.textOnly} text-only`);
    if (result.failed.length > 0) log('   Re-run to retry the failures.');
    console.log('');
}

main().catch((err) => {
    console.error('');
    console.error('❌ Embedding failed:', err.message);
    process.exit(1);
});
