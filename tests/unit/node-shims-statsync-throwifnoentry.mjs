#!/usr/bin/env bun
// Behavior test: the generated Node fs shim's statSync honors Node's
// { throwIfNoEntry: false } option — returning undefined for a missing path
// instead of throwing ENOENT. opencode's bash tool relies on this
// (statSync('/bin/sh', { throwIfNoEntry: false })).

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

const code = generateShimsCode();
const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + code + '\n;return { fs: __fsMod };'
);
// A bundled cell always arrives with the stat record for the same path:
// buildVfsMetadata() runs over the final bundle, after every eviction pass,
// so a facet cannot be handed content it has no record for.
const sandbox = factory(
  { 'home/user/present.txt': 'hi' },
  { 'home/user/present.txt': { type: 'file', size: 2, mode: 0o644, uid: 1000, gid: 1000 } },
  {}, {}, {}, null,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
);
const fs = sandbox.fs;

// Missing path + throwIfNoEntry:false → undefined (no throw).
assert.equal(fs.statSync('/bin/sh', { throwIfNoEntry: false }), undefined,
  'statSync(missing, {throwIfNoEntry:false}) should return undefined');
assert.equal(fs.lstatSync('/bin/sh', { throwIfNoEntry: false }), undefined,
  'lstatSync(missing, {throwIfNoEntry:false}) should return undefined');

// Missing path without the option → throws ENOENT (unchanged contract).
assert.throws(() => fs.statSync('/bin/sh'), /ENOENT/,
  'statSync(missing) should still throw ENOENT by default');

// Present file → real stat regardless of the option.
const st = fs.statSync('/home/user/present.txt', { throwIfNoEntry: false });
assert.ok(st && st.isFile(), 'statSync(present) returns a file stat');
assert.equal(st.size, 2, 'present file size is correct');

console.log('ok: statSync/lstatSync honor { throwIfNoEntry: false }');
console.log('\nALL node-shims statSync throwIfNoEntry unit tests passed');
