import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssetRow, groupRowsByColumns } from '../src/lib/sync/asset-row';
import type { DriveFile } from '../src/lib/sync/types';

const file = (over: Partial<DriveFile> = {}): DriveFile => ({
    id: 'f1', name: 'a.jpg', description: null, mimeType: 'image/jpeg', assetType: 'photo',
    folderPath: '/Library', width: 100, height: 80, duration: null,
    parsedCreator: null, parsedShootDate: null, parsedShootDescription: null,
    createdTime: '2026-01-01T00:00:00Z', modifiedTime: '2026-01-02T00:00:00Z',
    organicRights: null, organicRightsExpiration: null, paidRights: null, paidRightsExpiration: null,
    creator: null, projectDescription: null,
    ...over,
} as DriveFile);

test('a file present in Drive is live: trash fields are cleared', () => {
    const row = buildAssetRow(file());
    assert.equal(row.is_active, true);
    assert.equal(row.deleted_at, null);
    assert.equal(row.deleted_reason, null);
});

test('never writes thumbnail_url (callers own it)', () => {
    assert.equal('thumbnail_url' in buildAssetRow(file()), false);
});

test('rights: omitted without label data, written as null when labels were fetched', () => {
    assert.equal('organic_rights' in buildAssetRow(file()), false);
    const fetched = buildAssetRow(file(), { labelsFetched: true });
    assert.equal('organic_rights' in fetched, true);
    assert.equal(fetched.organic_rights, null);
    assert.equal(buildAssetRow(file({ organicRights: 'unlimited' } as Partial<DriveFile>)).organic_rights, 'unlimited');
});

test('user-managed creator/project_description are never nulled', () => {
    const row = buildAssetRow(file());
    assert.equal('creator' in row, false);
    assert.equal('project_description' in row, false);
});

test('groupRowsByColumns splits by exact key set, order-insensitive', () => {
    const groups = groupRowsByColumns([
        { a: 1, b: 2 }, { b: 3, a: 4 }, { a: 5 }, { a: 6, b: 7, c: 8 },
    ]);
    assert.deepEqual(groups.map((g) => g.length), [2, 1, 1]);
    // Within a group every row carries the same columns — nothing gets NULL-filled
    for (const g of groups) {
        const sig = Object.keys(g[0]).sort().join();
        assert.ok(g.every((r) => Object.keys(r).sort().join() === sig));
    }
});

import { embedInputsChanged } from '../src/lib/embedding-text';

test('embedInputsChanged: any embed-text field counts, null/undefined are equal', () => {
    const base = { name: 'a.jpg', description: null, folder_path: '/A', parsed_creator: null, parsed_shoot_description: 'Shoot' };
    assert.equal(embedInputsChanged(base, { ...base }), false);
    assert.equal(embedInputsChanged(base, { ...base, folder_path: '/B' }), true);
    assert.equal(embedInputsChanged(base, { ...base, parsed_creator: 'Jane Doe' }), true);
    assert.equal(embedInputsChanged(base, { ...base, name: 'b.jpg' }), true);
    assert.equal(embedInputsChanged(base, { ...base, description: undefined as unknown as null }), false);
});
