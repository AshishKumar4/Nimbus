#!/usr/bin/env bun
// One credential shape check (os-contracts isVfsCred): unsigned integer
// uid, gid, umask and supplementary groups. requireVfsCred, the shell's
// command identity and a persisted real-vite identity all take it, so none
// accepts what another refuses; sameCred is the one identity comparison.

import assert from 'node:assert/strict';
import { isVfsCred, requireVfsCred, sameCred } from '../../packages/core/src/runtime/os-contracts.ts';

const good = { uid: 1000, gid: 1000, groups: [1000, 27], umask: 0o022 };
assert.equal(isVfsCred(good), true);
assert.equal(isVfsCred({ uid: 0, gid: 0, groups: [], umask: 0 }), true);
for (const [why, value] of [
  ['null', null],
  ['a number', 1000],
  ['no groups', { uid: 1000, gid: 1000, umask: 0o022 }],
  ['a fractional uid', { ...good, uid: 1000.5 }],
  ['a negative gid', { ...good, gid: -1 }],
  ['a string umask', { ...good, umask: '022' }],
  ['a fractional group', { ...good, groups: [1000, 1.5] }],
  ['a negative group', { ...good, groups: [-2] }],
]) {
  assert.equal(isVfsCred(value), false, `${why} passed as a credential`);
  assert.throws(() => requireVfsCred(value, 'test'), /test requires process credentials/, `${why} was required as a credential`);
}
const required = requireVfsCred(good, 'test');
assert.deepEqual(required, good);
assert.notEqual(required.groups, good.groups, "a required credential shares its caller's groups");
assert.equal(sameCred(good, { ...good, groups: [1000, 27] }), true);
assert.equal(sameCred(good, { ...good, groups: [27, 1000] }), false);
assert.equal(sameCred(good, { ...good, umask: 0o077 }), false);
console.log('vfs cred shape: ok');
