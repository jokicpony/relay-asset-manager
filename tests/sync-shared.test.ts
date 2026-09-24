import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalizeSyncFolders, isInSyncScope, topFolderOf } from '../src/lib/sync/scope';
import { toDriveFile } from '../src/lib/sync/drive-file';
import { emptyRightsFields } from '../src/lib/sync/rights-labels';
import { fetchWithDriveRetry, isDriveRateLimitError } from '../src/lib/sync/drive-retry';
import { resolveFolderPathById, type FolderInfo } from '../src/lib/google/folder-path';
import { embedAssets } from '../src/lib/sync/embedder';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ── scope ────────────────────────────────────────────────────────────────
test('scope: case- and whitespace-insensitive top-folder match; empty list = no filter', () => {
    const folders = normalizeSyncFolders([' Photo Library ', 'VIDEO LIBRARY', '']);
    assert.deepEqual(folders, ['photo library', 'video library']);
    assert.equal(topFolderOf('/Photo Library/2026/Shoot'), 'photo library');
    assert.equal(isInSyncScope('/Photo Library/2026', folders), true);
    assert.equal(isInSyncScope('/Photo Library Archive/x', folders), false); // no prefix match
    assert.equal(isInSyncScope('/unknown', folders), false);
    assert.equal(isInSyncScope(null, folders), false);
    assert.equal(isInSyncScope('/Anything', []), true);
});

// ── drive-file ───────────────────────────────────────────────────────────
test('toDriveFile: video dims/duration, parsed name fields, date fallbacks', () => {
    const f = toDriveFile({
        id: 'v1', name: '20260205_Jane-Doe_Trail_003.mp4', mimeType: 'video/mp4', size: '1024',
        videoMediaMetadata: { width: 1920, height: 1080, durationMillis: '12500' },
        imageMediaMetadata: { width: 1, height: 1 },
        modifiedTime: '2026-02-06T00:00:00Z',
    }, '/Video Library', emptyRightsFields());
    assert.equal(f.assetType, 'video');
    assert.equal(f.width, 1920);
    assert.equal(f.duration, 12.5);
    assert.equal(f.fileSize, 1024);
    assert.equal(f.parsedCreator, 'Jane Doe');
    assert.equal(f.parsedShootDescription, 'Trail');
    assert.equal(f.createdTime, '2026-02-06T00:00:00Z'); // falls back to modifiedTime
    assert.equal(f.creator, null);
});

test('toDriveFile: images use image metadata, no duration', () => {
    const f = toDriveFile({ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg', imageMediaMetadata: { width: 800, height: 600 } },
        '/Photo Library', emptyRightsFields());
    assert.equal(f.assetType, 'photo');
    assert.equal(f.height, 600);
    assert.equal(f.duration, null);
});

// ── drive-retry ──────────────────────────────────────────────────────────
test('rate-limit detection covers 429 and 403 rate-limit reasons only', () => {
    assert.equal(isDriveRateLimitError({ code: 429 }), true);
    assert.equal(isDriveRateLimitError({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] }), true);
    assert.equal(isDriveRateLimitError({ code: 403, errors: [{ reason: 'insufficientFilePermissions' }] }), false);
    assert.equal(isDriveRateLimitError({ code: 404 }), false);
});

test('fetchWithDriveRetry retries 5xx then returns the success; 404 is not retried', async () => {
    let calls = 0;
    globalThis.fetch = (async () => (++calls < 2 ? new Response('', { status: 503 }) : new Response('ok'))) as typeof fetch;
    assert.equal((await fetchWithDriveRetry('https://x')).status, 200);
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 404 }); }) as typeof fetch;
    assert.equal((await fetchWithDriveRetry('https://x')).status, 404);
    assert.equal(calls, 1);
});

// ── folder walk ──────────────────────────────────────────────────────────
test('resolveFolderPathById: walks parents, inherits [relay-ignore], caches every level', async () => {
    const folders: Record<string, { name: string; parents: string[]; description?: string }> = {
        c: { name: 'Shoot', parents: ['b'] },
        b: { name: 'Archive', parents: ['a'], description: 'old stuff [relay-ignore]' },
        a: { name: 'Photo Library', parents: ['DRIVE'] },
    };
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
        calls++;
        const id = decodeURIComponent(String(url).split('/files/')[1].split('?')[0]);
        return new Response(JSON.stringify({ id, ...folders[id] }));
    }) as typeof fetch;

    const cache = new Map<string, FolderInfo>();
    const r = await resolveFolderPathById('tok', 'c', 'DRIVE', cache);
    assert.equal(r.path, '/Photo Library/Archive/Shoot');
    assert.equal(r.ignored, true);
    assert.deepEqual(cache.get('a'), { path: '/Photo Library', ignored: false });
    assert.equal(calls, 3);

    // A sibling under a cached ancestor needs one call
    folders.d = { name: 'Other', parents: ['a'] };
    const r2 = await resolveFolderPathById('tok', 'd', 'DRIVE', cache);
    assert.equal(r2.path, '/Photo Library/Other');
    assert.equal(r2.ignored, false);
    assert.equal(calls, 4);
});

// ── embedder ─────────────────────────────────────────────────────────────
test('embedder sends WebP thumbnails to Gemini as JPEG', async () => {
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c33' } }).webp().toBuffer();
    const supabase = {
        storage: { from: () => ({ download: async (p: string) => p.startsWith('custom_')
            ? { data: null, error: { message: 'nf' } }
            : { data: new Blob([new Uint8Array(webp)]), error: null } }) },
    } as never;

    let sentMime = '';
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        sentMime = body.requests[0].content.parts[1]?.inline_data?.mime_type;
        return new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }] }));
    }) as typeof fetch;

    const r = await embedAssets(supabase, 'key', [{
        id: 'a1', drive_file_id: 'd1', thumbnail_url: 'https://x.supabase.co/storage/v1/object/public/thumbnails/d1.webp',
        name: 'x.jpg', description: null, asset_type: 'photo', folder_path: '/', parsed_creator: null, parsed_shoot_description: null,
    }]);
    assert.equal(sentMime, 'image/jpeg');
    assert.equal(r.withImage, 1);
    assert.deepEqual(r.vectors.get('a1'), [0.1, 0.2]);
});

test('embedder falls back to text-only when the image is rejected', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer();
    const supabase = { storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array(png)]), error: null }) }) } } as never;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const hasImage = Boolean(JSON.parse(String(init.body)).requests[0].content.parts[1]);
        return hasImage
            ? new Response('bad image', { status: 400 })
            : new Response(JSON.stringify({ embeddings: [{ values: [1] }] }));
    }) as typeof fetch;

    const r = await embedAssets(supabase, 'key', [{
        id: 'a1', drive_file_id: 'd1', thumbnail_url: 'https://x/d1.webp', name: 'x.jpg', description: null,
        asset_type: 'photo', folder_path: '/', parsed_creator: null, parsed_shoot_description: null,
    }]);
    assert.equal(r.textOnly, 1);
    assert.equal(r.failed.length, 0);
});

test('embedder hands vectors to onBatch as each batch finishes', async () => {
    const supabase = { storage: { from: () => ({ download: async () => ({ data: null, error: { message: 'nf' } }) }) } } as never;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const n = JSON.parse(String(init.body)).requests.length;
        return new Response(JSON.stringify({ embeddings: Array.from({ length: n }, () => ({ values: [0] })) }));
    }) as typeof fetch;

    const assets = Array.from({ length: 25 }, (_, i) => ({
        id: `a${i}`, drive_file_id: `d${i}`, thumbnail_url: null, name: `${i}.jpg`, description: null,
        asset_type: 'photo', folder_path: '/', parsed_creator: null, parsed_shoot_description: null,
    }));
    const batches: number[] = [];
    const r = await embedAssets(supabase, 'key', assets, { onBatch: async (v) => { batches.push(v.size); } });
    assert.deepEqual(batches, [20, 5]);
    assert.equal(r.vectors.size, 25);
    assert.equal(r.textOnly, 25);
});
