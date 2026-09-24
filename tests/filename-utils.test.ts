import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, resolveCreator } from '../src/lib/filename-utils';

// parseFilename feeds the embedding text: a change in its output triggers a
// mass re-embed on the next sync (see CLAUDE.md), so its behaviour is pinned.

test('date-first: date, creator, description, sequence', () => {
    const r = parseFilename('20260205_Jane-Doe_Tailgate_Camp-Bottle_010.jpg');
    assert.equal(r.parsed, true);
    assert.equal(r.creator, 'Jane Doe');
    assert.equal(r.shootDescription, 'Tailgate / Camp Bottle');
    assert.equal(r.sequence, '010');
    assert.equal(r.shootDate?.getFullYear(), 2026);
    assert.equal(r.shootDate?.getMonth(), 1);
    assert.equal(r.shootDate?.getDate(), 5);
});

test('date-first without a trailing sequence keeps the last token as description', () => {
    const r = parseFilename('20260205_Jane-Doe_Tailgate.jpg');
    assert.equal(r.sequence, null);
    assert.equal(r.shootDescription, 'Tailgate');
});

test('brand-first: $brand creator, $tags, plain description tokens', () => {
    const r = parseFilename('$Acme_TrailRun_Mountain-Background_$Lifestyle_$Social_$blue_1.mp4');
    assert.equal(r.parsed, true);
    assert.equal(r.creator, 'Acme');
    assert.equal(r.shootDescription, 'TrailRun / Mountain Background');
    assert.deepEqual(r.tags, ['Lifestyle', 'Social', 'blue']);
    assert.equal(r.sequence, '1');
    assert.equal(r.shootDate, null);
});

test('generic names are not marked parsed', () => {
    const r = parseFilename('beach_sunset_02.png');
    assert.equal(r.parsed, false);
    assert.equal(r.creator, null);
    assert.equal(r.shootDescription, 'beach / sunset');
    assert.equal(r.sequence, '02');
});

test('single-token names and double underscores', () => {
    assert.equal(parseFilename('IMG1234.jpg').parsed, false);
    assert.equal(parseFilename('20260205__Jane-Doe_Shoot_1.jpg').creator, 'Jane Doe');
});

test('resolveCreator prefers the explicit label value', () => {
    assert.equal(resolveCreator({ name: '20260205_Jane-Doe_Shoot_1.jpg', creator: 'Label Person' }), 'Label Person');
    assert.equal(resolveCreator({ name: '20260205_Jane-Doe_Shoot_1.jpg', creator: null }), 'Jane Doe');
});
