#!/usr/bin/env npx tsx
/**
 * One-time (re-runnable) cleanup of the `thumbnails` storage bucket.
 *
 * Before encodeThumbnail existed, thumbnails were stored as whatever bytes
 * came back — Drive's 800px JPEG labelled image/webp, or, on the in-app
 * ingest fallback, the full-resolution original (up to ~20 MB). The sync
 * never replaces an existing thumbnail, so those stayed. This script runs
 * every stored thumbnail through the same encoder the pipeline now uses
 * (real WebP, ≤800px) and overwrites it in place — same path, same public
 * URL, so no database changes are needed.
 *
 * Only files that actually need shrinking are rewritten: larger than 800px
 * on the long side (full originals), or heavier than 500 KB. Normal Drive
 * thumbnails (~100 KB, 800px) are left exactly as they are — only files the
 * bucket listing reports as over 200 KB are even downloaded. Custom
 * thumbnails (user-captured video frames, custom_*.webp) are never touched —
 * they can't be regenerated. Files that can't be decoded (e.g. HEIC
 * originals) are reported, not modified.
 *
 * Every replaced file's original bytes are saved under .thumb-backup/<date>/
 * first, so a bad run can be undone by re-uploading them.
 *
 * Usage:
 *   npx tsx scripts/reencode-thumbnails.ts            # dry run (default)
 *   npx tsx scripts/reencode-thumbnails.ts --apply    # write changes
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import { encodeThumbnail, THUMBNAIL_MAX_PX } from '../src/lib/sync/thumbnail-encode';

dotenv.config({ path: path.resolve(__dirname, '../.env.local'), quiet: true });

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 4;
const SCAN_ABOVE_BYTES = 200 * 1024; // don't even download smaller files
const HEAVY_BYTES = 500 * 1024;      // an 800px thumbnail heavier than this gets re-encoded

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase = createClient(url, key);
const bucket = supabase.storage.from('thumbnails');

const backupDir = path.resolve(__dirname, '../.thumb-backup', new Date().toISOString().slice(0, 10));
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function listAll(): Promise<{ name: string; size: number }[]> {
    const out: { name: string; size: number }[] = [];
    for (let offset = 0; ; offset += 1000) {
        const { data, error } = await bucket.list('', {
            limit: 1000, offset, sortBy: { column: 'name', order: 'asc' },
        });
        if (error) throw new Error(`Bucket listing failed: ${error.message}`);
        for (const f of data ?? []) {
            out.push({ name: f.name, size: (f.metadata as { size?: number } | null)?.size ?? 0 });
        }
        if (!data || data.length < 1000) break;
    }
    return out;
}

// Storage throttles bursts with bodiless errors — back off and retry.
async function downloadWithRetry(name: string, attempts = 4): Promise<Buffer> {
    for (let i = 1; ; i++) {
        const { data: blob, error } = await bucket.download(name);
        if (!error && blob) return Buffer.from(await blob.arrayBuffer());
        if (i >= attempts) throw new Error(error?.message || 'download failed after retries');
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
}

async function main() {
    console.log(APPLY ? '⚠️  APPLY mode — thumbnails will be overwritten' : '🔍 Dry run — nothing will be written (pass --apply to write)');

    const all = await listAll();
    const targets = all.filter((f) =>
        !f.name.startsWith('custom_') && f.name.endsWith('.webp') && f.size > SCAN_ABOVE_BYTES);
    console.log(`${all.length} objects — checking ${targets.length} over ${SCAN_ABOVE_BYTES / 1024} KB; the rest are left untouched`);
    if (APPLY) fs.mkdirSync(backupDir, { recursive: true });

    let replaced = 0, kept = 0, undecodable = 0, failed = 0, done = 0;
    let bytesBefore = 0, bytesAfter = 0;
    const undecodableNames: string[] = [];
    const failedNames: string[] = [];

    const queue = [...targets];
    const worker = async () => {
        while (queue.length > 0) {
            const f = queue.shift()!;
            try {
                const original = await downloadWithRetry(f.name);

                const meta = await sharp(original, { failOn: 'none' }).metadata().catch(() => null);
                const encoded = await encodeThumbnail(original);
                if (!meta || !encoded) {
                    undecodable++;
                    undecodableNames.push(f.name);
                    continue;
                }

                const oversized = Math.max(meta.width ?? 0, meta.height ?? 0) > THUMBNAIL_MAX_PX;
                const heavy = original.length > HEAVY_BYTES;
                if (!(oversized || heavy) || encoded.length >= original.length) {
                    kept++;
                    continue;
                }

                if (APPLY) {
                    fs.writeFileSync(path.join(backupDir, f.name), original);
                    const { error: upErr } = await bucket.upload(f.name, encoded, {
                        contentType: 'image/webp',
                        upsert: true,
                    });
                    if (upErr) throw new Error(`upload: ${upErr.message}`);
                }
                replaced++;
                bytesBefore += original.length;
                bytesAfter += encoded.length;
            } catch (err) {
                failed++;
                failedNames.push(`${f.name} (${err instanceof Error ? err.message : String(err)})`);
            } finally {
                done++;
                if (done % 100 === 0) {
                    console.log(`  ${done}/${targets.length} — ${replaced} ${APPLY ? 'replaced' : 'would replace'}, saving ${mb(bytesBefore - bytesAfter)}`);
                }
            }
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log('');
    console.log(`${APPLY ? 'Replaced' : 'Would replace'}: ${replaced} (${mb(bytesBefore)} → ${mb(bytesAfter)}, saving ${mb(bytesBefore - bytesAfter)})`);
    console.log(`Already fine (kept): ${kept}`);
    console.log(`Undecodable (left alone): ${undecodable}`);
    console.log(`Failed: ${failed}`);
    for (const n of undecodableNames.slice(0, 20)) console.log(`  undecodable: ${n}`);
    for (const n of failedNames.slice(0, 20)) console.log(`  failed: ${n}`);
    if (APPLY && replaced > 0) console.log(`Originals backed up to ${backupDir}`);
}

main().catch((err) => {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
});
