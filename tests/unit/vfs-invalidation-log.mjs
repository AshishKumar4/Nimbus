#!/usr/bin/env bun
// The supervisor's invalidation log is what lets a facet keep a cache of the
// VFS without keeping a stale one. A facet holding a resident set stamped at
// (epoch, cursor) asks what changed since; anything the log fails to report
// is a byte the facet will serve stale forever.
//
// The hook is sited in bumpRevision, NOT in the writeBatch funnel, because
// five mutation paths bypass that funnel — mkdir, utimes, chmod, chown and
// rename — and all six reach bumpRevision. rename in particular is the
// mutation most likely to break a build tool, so it is asserted directly.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const enc = new TextEncoder();

vfs.mkdir('/home/user/d', { recursive: true });

// An unknown epoch cannot be repaired incrementally: the caller's revisions
// belong to a different supervisor incarnation and mean nothing here.
const first = rawVfs.invalidatedSince(null, 0);
assert.equal(first.poison, true, 'unknown epoch poisons');
assert.equal(typeof first.epoch, 'string');
const epoch = first.epoch;

// Nothing committed since the cursor — the case that has to be free.
let acq = rawVfs.invalidatedSince(epoch, first.rev);
assert.equal(acq.poison, false);
assert.deepEqual(acq.paths, [], 'no writes since cursor -> empty delta');

// A write reports the mutated path AND its parent. Both matter: content
// cells key on the exact path, directory-shape views key on the parent.
// Reporting only the path would let a facet read a file's bytes coherently
// while still believing the file does not exist.
vfs.writeFile('/home/user/d/f.txt', enc.encode('x'));
acq = rawVfs.invalidatedSince(epoch, first.rev);
assert.equal(acq.poison, false);
assert.ok(acq.paths.includes('home/user/d/f.txt'), 'mutated path in delta');
assert.ok(acq.paths.includes('home/user/d'), 'parent dir in delta');

// Re-acquiring at the returned cursor is empty — the delta is consumed.
assert.deepEqual(
  rawVfs.invalidatedSince(epoch, acq.rev).paths,
  [],
  'advanced cursor -> empty delta',
);

// rename bypasses the writeBatch funnel. A hook sited there would miss it.
const beforeRename = acq.rev;
vfs.rename('home/user/d/f.txt', 'home/user/d/g.txt');
acq = rawVfs.invalidatedSince(epoch, beforeRename);
assert.ok(acq.paths.includes('home/user/d/g.txt'), 'rename destination in delta');

// chmod likewise bypasses the funnel.
const beforeChmod = acq.rev;
vfs.chmod('home/user/d/g.txt', 0o600);
assert.ok(
  rawVfs.invalidatedSince(epoch, beforeChmod).paths.includes('home/user/d/g.txt'),
  'chmod in delta',
);

// A cursor ahead of our clock cannot be honoured. Failing open here would
// hand the caller a cache it believes is current, which is the one direction
// this protocol may never fail in.
assert.equal(rawVfs.invalidatedSince(epoch, 99999).poison, true, 'future cursor poisons');

// Two incarnations never share an epoch, so a cursor cannot survive a restart
// and be mistaken for a current one (the ABA failure the epoch exists for).
const otherVfs = new SqliteVFS(createSqliteVfsTestHarness().sql, harness.ctx);
assert.notEqual(otherVfs.epoch, rawVfs.epoch, 'epochs are per-incarnation');
assert.equal(
  otherVfs.invalidatedSince(epoch, 0).poison,
  true,
  "another incarnation's cursor poisons",
);

console.log('vfs-invalidation-log: all assertions passed');
