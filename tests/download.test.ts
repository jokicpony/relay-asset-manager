import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntryNamer, sanitizeEntryName } from '../src/lib/download/shared';
import { mapWithConcurrency } from '../src/lib/download/drive-zip';

test('zip entry names can never become paths or be empty', () => {
    assert.equal(sanitizeEntryName('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(sanitizeEntryName('a\\b/c.jpg'), 'a_b_c.jpg');
    assert.equal(sanitizeEntryName('..'), 'file');
    assert.equal(sanitizeEntryName('  \u0000 '), 'file');
});

test('duplicate names get " (n)" before the extension, case-insensitively', () => {
    const name = createEntryNamer();
    assert.equal(name('Shot.jpg'), 'Shot.jpg');
    assert.equal(name('shot.JPG'), 'shot (2).JPG');
    assert.equal(name('Shot.jpg'), 'Shot (3).jpg');
    assert.equal(name('README'), 'README');
    assert.equal(name('readme'), 'readme (2)');
});

test('mapWithConcurrency keeps order and respects the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, n * 3));
        inFlight--;
        return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.ok(peak <= 2);
});
