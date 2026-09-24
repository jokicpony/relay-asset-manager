import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBadge, isAssetFullyExpired, isAnyRightExpired } from '../src/lib/badge-utils';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

test('badge tiers by days remaining', () => {
    assert.equal(computeBadge('ORG', 'unlimited', null).color, 'green');
    assert.equal(computeBadge('ORG', null, null).status, 'Not Labeled');
    assert.equal(computeBadge('ORG', 'expired', null).color, 'red');
    assert.equal(computeBadge('ORG', 'limited', inDays(200)).color, 'green');
    assert.equal(computeBadge('ORG', 'limited', inDays(45)).color, 'amber');
    assert.equal(computeBadge('ORG', 'limited', inDays(10)).color, 'orange');
    assert.equal(computeBadge('ORG', 'limited', inDays(-1)).status, 'Expired');
    // limited with no date can't be verified — treated as expired
    assert.equal(computeBadge('ORG', 'limited', null).color, 'red');
});

test('fully expired needs one dead track and nothing usable on the other', () => {
    const a = (organicRights: never, paidRights: never) => ({
        organicRights, paidRights, organicRightsExpiration: null, paidRightsExpiration: null,
    });
    assert.equal(isAssetFullyExpired(a('expired' as never, 'expired' as never)), true);
    assert.equal(isAssetFullyExpired(a('expired' as never, null as never)), true);
    assert.equal(isAssetFullyExpired(a('expired' as never, 'unlimited' as never)), false);
    assert.equal(isAssetFullyExpired(a(null as never, null as never)), false);
    assert.equal(isAnyRightExpired(a('unlimited' as never, 'expired' as never)), true);
    assert.equal(isAnyRightExpired(a('unlimited' as never, null as never)), false);
});
