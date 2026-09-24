import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    batchProgress,
    hiddenSourceFileIds,
    isRetryable,
    revertTargets,
} from '../src/lib/namer/batch-utils';
import { isInSharedDrive, DriveScopeUnavailableError } from '../src/lib/google/drive-scope';
import type { BatchFile, BatchInfo } from '../src/lib/namer/types';

const file = (id: string, f: Partial<BatchFile> = {}): BatchFile =>
    ({ id, name: `${id}.jpg`, proposedName: `${id}-new.jpg`, status: 'queued', finalName: null, ...f });

const batch = (files: BatchFile[], status: BatchInfo['status'] = 'completed'): BatchInfo => ({
    id: 'b', files, status, progress: batchProgress(files), timestamp: 0, sourceFolderId: 's', destFolderId: 'd',
});

const moved = { status: 'success' as const, doneSteps: ['move' as const] };

test('retryable: move failures and successes with warnings; not clean, cancelled or reverted', () => {
    assert.equal(isRetryable(file('a', { status: 'error', error: 'x' })), true);
    assert.equal(isRetryable(file('b', { ...moved, warnings: ['Label: 500'] })), true);
    assert.equal(isRetryable(file('c', moved)), false);
    assert.equal(isRetryable(file('d', { status: 'cancelled' })), false);
    assert.equal(isRetryable(file('e', { ...moved, warnings: ['x'], revert: 'done' })), false);
});

test('progress counts cancelled as completed and only move failures as errors', () => {
    const p = batchProgress([file('a', moved), file('b', { status: 'error' }), file('c', { status: 'cancelled' }), file('d')]);
    assert.deepEqual(p, { completed: 3, total: 4, errors: 1 });
});

test('source list hides files a batch owns; cancelled and reverted ones reappear', () => {
    const b = batch([
        file('queued'),
        file('ok', moved),
        file('failed', { status: 'error' }),
        file('cancelled', { status: 'cancelled' }),
        file('reverted', { ...moved, revert: 'done' }),
    ]);
    assert.deepEqual([...hiddenSourceFileIds([b])].sort(), ['failed', 'ok', 'queued']);
    // A fully reverted batch releases everything
    assert.equal(hiddenSourceFileIds([{ ...b, status: 'reverted' }]).size, 0);
    // While reverting, never-moved files are released (no longer retryable)
    assert.deepEqual([...hiddenSourceFileIds([{ ...b, status: 'revert-failed' }])].sort(), ['ok']);
});

test('revert targets moved files that are not yet reverted', () => {
    const b = batch([
        file('ok', moved),
        file('done', { ...moved, revert: 'done' }),
        file('again', { ...moved, revert: 'failed' }),
        file('never', { status: 'error' }),
    ]);
    assert.deepEqual(revertTargets(b).map(f => f.id), ['ok', 'again']);
});

// ── isInSharedDrive ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('isInSharedDrive: 404 / other drive → false (fail closed)', async () => {
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    assert.equal(await isInSharedDrive('t', 'file', 'drive'), false);
    globalThis.fetch = (async () => Response.json({ driveId: 'other' })) as typeof fetch;
    assert.equal(await isInSharedDrive('t', 'file', 'drive'), false);
    globalThis.fetch = (async () => Response.json({ driveId: 'drive' })) as typeof fetch;
    assert.equal(await isInSharedDrive('t', 'file', 'drive'), true);
});

test('isInSharedDrive: network failure → retryable DriveScopeUnavailableError, not false', async () => {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await assert.rejects(isInSharedDrive('t', 'file', 'drive'), DriveScopeUnavailableError);
});

test('isInSharedDrive: persistent 503 → DriveScopeUnavailableError after retries', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('', { status: 503 }); }) as typeof fetch;
    await assert.rejects(isInSharedDrive('t', 'file', 'drive'), DriveScopeUnavailableError);
    assert.equal(calls, 3); // first try + 2 retries
});
