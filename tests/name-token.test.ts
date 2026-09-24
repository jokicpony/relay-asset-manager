import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeNameToken } from '../src/lib/namer/name-token';

test('underscores and whitespace become hyphens (they would split parsed tokens)', () => {
    assert.equal(sanitizeNameToken('Trail  Run_Day'), 'Trail-Run-Day');
});

test('filename-illegal characters are dropped, ends trimmed', () => {
    assert.equal(sanitizeNameToken('  a/b\\c:d*e?"f<g>h|i  '), 'abcdefghi');
});

test('brand-first $ prefix is preserved', () => {
    assert.equal(sanitizeNameToken('$Acme'), '$Acme');
});
