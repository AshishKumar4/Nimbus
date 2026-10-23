#!/usr/bin/env bun
// A position (runtime/feed-position.ts) is where a reader of the namespace
// stands on each fed mount's feed. What the store compares by it:
//   - a path's clock is its deepest fed mount's feed; a revision read before
//     a mount covered the path and one read after are not of one clock;
//   - an answer at or before the store's cursor is old news, per feed;
//   - an entry is news above its own feed's cursor in the store;
//   - one incarnation keeps every feed's epoch.

import assert from 'node:assert/strict';
import {
  abovePoint, feedFor, feedPointOf, floorFor, notAfter, positionOf, rootOf, sameClock, sameEpochs, samePosition,
} from '../../packages/core/src/runtime/feed-position.ts';

const root = { epoch: 'sqlite', cursor: 20 };
const before = positionOf('t1', { '/': root });
const covered = positionOf('t2', { '/': root, '/home/user/m': { epoch: 'mem', cursor: 2 } });

assert.equal(feedPointOf(covered, 'home/user/m/f'), '/home/user/m');
assert.equal(feedPointOf(covered, '/home/user/mx'), '/', 'a sibling of a point is not under it');
assert.equal(feedFor(covered, 'home/user/m/f').cursor, 2);
// The deepest point at or above a key, whatever order the feeds are in; a point itself is under itself.
const nested = positionOf('t3', { '/home/user/m/n': { epoch: 'inner', cursor: 1 }, '/': root, '/home/user/m': { epoch: 'mem', cursor: 2 }, '/dev': { epoch: 'dev', cursor: 0 } });
assert.equal(feedPointOf(nested, 'home/user/m/n/f'), '/home/user/m/n');
assert.equal(feedPointOf(nested, '/home/user/m/n'), '/home/user/m/n');
assert.equal(feedPointOf(nested, 'home/user/m/nx'), '/home/user/m');
assert.equal(feedPointOf(nested, 'home/user/m'), '/home/user/m');
assert.equal(feedPointOf(nested, 'home/user'), '/', 'above every point');
assert.equal(feedPointOf(nested, 'dev'), '/dev');
assert.equal(feedPointOf(nested, 'devices/x'), '/');
for (const top of ['', '/']) assert.equal(feedPointOf(nested, top), '/');
assert.deepEqual(rootOf(covered), root);

// A file the root held, then a mount made over it: not one clock, whatever the root's revisions say.
assert.equal(sameClock(before, covered, 'home/user/m/f'), false, 'a mount made over a path since is another clock');
assert.equal(sameClock(covered, before, 'home/user/m/f'), false, 'and a mount gone since');
assert.equal(sameClock(before, covered, 'home/user/other'), true, 'a path the mount does not cover keeps the root\'s');
assert.equal(sameClock(covered, positionOf('t2', { '/': root, '/home/user/m': { epoch: 'mem2', cursor: 2 } }), 'home/user/m/f'), false, 'another backend at the point');

// Old news, per feed.
const later = positionOf('t2', { '/': { epoch: 'sqlite', cursor: 25 }, '/home/user/m': { epoch: 'mem', cursor: 2 } });
assert.equal(notAfter(covered, later), true);
assert.equal(notAfter(later, covered), false);
assert.equal(notAfter(covered, before), false, 'another table is never old news');
assert.equal(floorFor(later, covered, 'home/user/m/f'), 2, 'a mount\'s entry is news above its own feed\'s cursor');
assert.equal(floorFor(later, covered, 'home/user/a'), 20);
assert.equal(floorFor(later, before, 'home/user/a'), -1, 'across tables, everything is news');

assert.equal(sameEpochs(covered, later), true);
assert.equal(sameEpochs(covered, before), false);
assert.equal(samePosition(covered, positionOf('t2', { '/': { epoch: 'sqlite', cursor: 20 }, '/home/user/m': { epoch: 'mem', cursor: 2 } })), true);
assert.equal(samePosition(covered, later), false);

assert.equal(abovePoint(covered, 'home/user'), true);
assert.equal(abovePoint(covered, 'home/user/m'), false, 'a point is not above itself');
assert.equal(abovePoint(before, 'home/user'), false);

console.log('feed-position: ok');
