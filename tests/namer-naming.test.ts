import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildProposedName,
    counterTokenIndex,
    dedupeName,
    findFreeCounterStart,
} from '../src/lib/namer/naming';
import { parseFilename } from '../src/lib/filename-utils';
import type { SchemaField } from '../src/lib/namer/types';

const field = (f: Partial<SchemaField> & Pick<SchemaField, 'id' | 'type'>): SchemaField =>
    ({ label: f.id, value: '', required: false, ...f });

const FIELDS: SchemaField[] = [
    field({ id: 'date', type: 'date', value: '20260205' }),
    field({ id: 'creator', type: 'text', value: 'Jane Doe' }),
    field({ id: 'desc', type: 'text', value: 'Camp_Bottle' }),
    field({ id: 'index', type: 'counter' }),
];

test('buildProposedName: sanitized tokens, padded counter, original extension', () => {
    assert.equal(buildProposedName(FIELDS, 'IMG_0001.JPG', 7), '20260205_Jane-Doe_Camp-Bottle_007.JPG');
});

test('buildProposedName: empty tokens are skipped; nothing emitted → original name', () => {
    const fields = [field({ id: 'a', type: 'text', value: '  ' }), field({ id: 'b', type: 'text', value: 'X' })];
    assert.equal(buildProposedName(fields, 'a.png', 1), 'X.png');
    assert.equal(buildProposedName([field({ id: 'a', type: 'text' })], 'a.png', 1), 'a.png');
});

test('counterTokenIndex counts only emitted tokens', () => {
    assert.equal(counterTokenIndex(FIELDS), 3);
    assert.equal(counterTokenIndex([field({ id: 'blank', type: 'text' }), ...FIELDS]), 3);
    assert.equal(counterTokenIndex(FIELDS.slice(0, 3)), null);
});

test('dedupeName bumps a trailing counter (skipping taken) instead of appending _v2', () => {
    const taken = new Set(['20260205_Jane_Trip_001.jpg', '20260205_Jane_Trip_002.jpg']);
    const name = dedupeName('20260205_Jane_Trip_001.jpg', n => taken.has(n), 3);
    assert.equal(name, '20260205_Jane_Trip_003.jpg');
    // …and the result still parses with a sequence (the _v2 form did not)
    assert.equal(parseFilename(name).sequence, '003');
    assert.equal(parseFilename(name).shootDescription, 'Trip');
});

test('dedupeName bumps a mid-name counter at its token index', () => {
    const taken = new Set(['A_001_B.jpg']);
    assert.equal(dedupeName('A_001_B.jpg', n => taken.has(n), 1), 'A_002_B.jpg');
});

test('dedupeName keeps _vN for names without a counter (e.g. passthrough camera names)', () => {
    const taken = new Set(['IMG_0001.jpg', 'IMG_0001_v2.jpg']);
    assert.equal(dedupeName('IMG_0001.jpg', n => taken.has(n), null), 'IMG_0001_v3.jpg');
    assert.equal(dedupeName('free.jpg', n => taken.has(n), null), 'free.jpg');
});

test('findFreeCounterStart skips past names already in the destination', () => {
    const taken = new Set(['X_001.jpg', 'X_002.jpg', 'X_005.jpg']);
    const nameAt = (num: number) => buildProposedName([field({ id: 'p', type: 'text', value: 'X' }), field({ id: 'i', type: 'counter' })], 'a.jpg', num);
    // Three files: 003–005 hits 005, so the first clear run is 006–008
    assert.equal(findFreeCounterStart(1, 3, nameAt, n => taken.has(n)), 6);
    // Two files fit in 003–004
    assert.equal(findFreeCounterStart(1, 2, nameAt, n => taken.has(n)), 3);
    assert.equal(findFreeCounterStart(1, 0, nameAt, n => taken.has(n)), 1);
});

test('findFreeCounterStart returns start when names do not depend on the counter', () => {
    assert.equal(findFreeCounterStart(4, 2, () => 'same.jpg', () => true), 4);
});
