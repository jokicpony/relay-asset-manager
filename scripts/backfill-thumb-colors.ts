#!/usr/bin/env npx tsx
/**
 * Fill assets.thumb_color for assets that don't have one yet, by reading
 * each asset's stored thumbnail and taking its dominant colour. New
 * thumbnails get a colour at creation (sync, in-app ingest, custom frames);
 * this covers everything created before that existed. Re-runnable: only rows
 * with thumb_color IS NULL are touched.
 *
 * Requires supabase/migrations/2026-09-24_add_thumb_color.sql.
 *
 * Usage:
 *   npx tsx scripts/backfill-thumb-colors.ts            # dry run (counts only)
 *   npx tsx scripts/backfill-thumb-colors.ts --apply    # write colours
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import { thumbnailColor } from '../src/lib/sync/thumbnail-encode';

dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 16;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase = createClient(url, key);

async function fetchWithRetry(src: string, attempts = 4): Promise<Buffer> {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(src);
            if (res.ok) return Buffer.from(await res.arrayBuffer());
            if (i >= attempts) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
            if (i >= attempts) throw err;
        }
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
}

async function main() {
    const rows: { id: string; thumbnail_url: string }[] = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
            .from('assets')
            .select('id, thumbnail_url')
            .is('thumb_color', null)
            .not('thumbnail_url', 'is', null)
            .like('thumbnail_url', 'http%')
            .order('id')
            .range(from, from + 999);
        if (error) throw new Error(`Query failed: ${error.message} (was the thumb_color migration applied?)`);
        rows.push(...(data ?? []));
        if (!data || data.length < 1000) break;
    }
    console.log(`${rows.length} assets need a colour${APPLY ? '' : ' — dry run, pass --apply to write'}`);
    if (!APPLY || rows.length === 0) return;

    let done = 0, written = 0, failed = 0;
    const queue = [...rows];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (queue.length > 0) {
            const row = queue.shift()!;
            try {
                const color = await thumbnailColor(await fetchWithRetry(row.thumbnail_url));
                if (!color) throw new Error('undecodable');
                const { error } = await supabase.from('assets')
                    .update({ thumb_color: color })
                    .eq('id', row.id)
                    .is('thumb_color', null);
                if (error) throw new Error(error.message);
                written++;
            } catch {
                failed++;
            }
            if (++done % 500 === 0) console.log(`  ${done}/${rows.length}`);
        }
    }));
    console.log(`Wrote ${written} colours, ${failed} failed (re-run to retry failures)`);
}

main().catch((err) => {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
});
