import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAssetList } from '../src/lib/supabase/queries';
import type { Asset } from '../src/types';

const asset = (id: string, folderPath: string): Asset => ({
    id, driveFileId: `d-${id}`, name: `${id}.jpg`, description: null, mimeType: 'image/jpeg',
    assetType: 'photo', folderPath, thumbnailUrl: '', width: 1, height: 1,
    organicRights: null, organicRightsExpiration: null, paidRights: null, paidRightsExpiration: null,
    creator: null, projectDescription: null, tags: [], createdAt: '2026-01-01',
});

test('no shortcuts: list is returned unchanged', () => {
    const assets = [asset('a', '/X')];
    assert.equal(expandAssetList({ assets, shortcuts: [] }), assets);
});

test('each (asset, folder) shortcut becomes one clone after the masters', () => {
    const out = expandAssetList({
        assets: [asset('a', '/Lib/A'), asset('b', '/Lib/B')],
        shortcuts: [['a', '/Proj/1'], ['a', '/Proj/2'], ['a', '/Proj/1'], ['missing', '/Proj/3']],
    });
    assert.deepEqual(out.map((x) => x.id), ['a', 'b', 'a::sc::/Proj/1', 'a::sc::/Proj/2']);

    const master = out[0];
    assert.deepEqual(master.shortcutFolders, ['/Proj/1', '/Proj/2']); // deduped
    assert.equal(master.isShortcut, undefined);

    const clone = out[2];
    assert.equal(clone.isShortcut, true);
    assert.equal(clone.folderPath, '/Proj/1');
    assert.equal(clone.originalFolderPath, '/Lib/A');
    assert.equal(clone.shortcutFolders, undefined);
});
