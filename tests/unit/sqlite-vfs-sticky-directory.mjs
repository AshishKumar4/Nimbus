#!/usr/bin/env bun
// The sticky bit, enforced.
//
// A world-writable shared directory is only safe because of mode 1777 rather
// than 0777: write permission on a directory normally authorises removing or
// renaming anything inside it, and the sticky bit narrows that to the entry's
// owner, the directory's owner, and root. Nothing here enforced it, so the
// mode said one thing and the filesystem did another — any principal with the
// directory's `w` bit could delete every other principal's files.
//
// The bit constrains the DIRECTORY ENTRY, not the file. So a sticky directory
// does not stop a co-tenant from writing through a file it has `w` on; it
// stops unlink, rmdir, recursive remove, and rename in both directions.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const ALICE = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const BOB = Object.freeze({ uid: 1001, gid: 1001, groups: Object.freeze([1001]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
const alice = raw.as(ALICE);
const bob = raw.as(BOB);

// `mkdir` applies the credential's umask, so the modes under test are set
// explicitly: 1777 is the shared-scratch mode, 0777 the same without the bit.
makeDir('tmp', 0o1777);
makeDir('shared', 0o777);

seed('tmp/alice-note', 'sticky');
seed('shared/alice-note', 'plain');

// ── A co-tenant cannot unlink someone else's file out of a sticky dir ───────
assert.throws(() => bob.unlink('tmp/alice-note'), /EPERM/, 'sticky blocks a co-tenant unlink');
assert.equal(root.exists('tmp/alice-note'), true, 'the refused unlink did not happen');

// ...and the same directory without the sticky bit still allows it, so the
// test is measuring the bit rather than ordinary permissions.
bob.unlink('shared/alice-note');
assert.equal(root.exists('shared/alice-note'), false, '0777 keeps its normal meaning');

// ── The owner of the entry may still remove it ──────────────────────────────
alice.unlink('tmp/alice-note');
assert.equal(root.exists('tmp/alice-note'), false, 'the entry owner is unaffected');

// ── The owner of the DIRECTORY may remove anything in it ────────────────────
makeDir('adir', 0o1777);
root.chown('adir', ALICE.uid, ALICE.gid);
seedAs(bob, 'adir/bob-note', 'bobs');
alice.unlink('adir/bob-note');
assert.equal(root.exists('adir/bob-note'), false, 'the directory owner is unaffected');

// ── root is unaffected ──────────────────────────────────────────────────────
seed('tmp/root-can-remove', 'x');
root.unlink('tmp/root-can-remove');
assert.equal(root.exists('tmp/root-can-remove'), false, 'uid 0 is unaffected');

// ── rename is a directory mutation at BOTH ends ─────────────────────────────
seed('tmp/alice-src', 'src');
assert.throws(() => bob.rename('tmp/alice-src', 'tmp/bob-dest'), /EPERM/, 'sticky blocks moving it out');
assert.equal(root.exists('tmp/alice-src'), true);

seed('tmp/alice-dest', 'dest');
seedAs(bob, 'tmp/bob-src', 'bob');
assert.throws(
  () => bob.rename('tmp/bob-src', 'tmp/alice-dest'),
  /EPERM/,
  'sticky blocks clobbering someone else\'s entry',
);
assert.equal(root.readFileString('tmp/alice-dest'), 'dest', 'the destination survived');

// ── rmdir and recursive remove obey the same rule ───────────────────────────
makeDir('tmp/alice-dir', 0o755);
root.chown('tmp/alice-dir', ALICE.uid, ALICE.gid);
assert.throws(() => bob.rmdir('tmp/alice-dir'), /EPERM/, 'sticky blocks a co-tenant rmdir');
assert.equal(root.exists('tmp/alice-dir'), true);

makeDir('tmp/alice-tree', 0o777);
root.chown('tmp/alice-tree', ALICE.uid, ALICE.gid);
seed('tmp/alice-tree/inner', 'inner');
assert.throws(
  () => bob.removeRecursive('tmp/alice-tree'),
  /EPERM/,
  'sticky blocks a co-tenant recursive remove',
);
assert.equal(root.exists('tmp/alice-tree/inner'), true, 'the refused recursive remove did not happen');

// ── The bit constrains the entry, not the bytes ─────────────────────────────
//
// Stated so nobody reads the refusals above as isolation: POSIX sticky says
// nothing about write access to a file whose mode already grants it.
root.writeFile('tmp/world-writable', 'before', { mode: 0o666 });
root.chmod('tmp/world-writable', 0o666);
bob.writeFile('tmp/world-writable', 'after');
assert.equal(root.readFileString('tmp/world-writable'), 'after', 'sticky does not imply file isolation');

console.log('sqlite vfs sticky directory: ok');

function makeDir(path, mode) {
  root.mkdir(path, { mode });
  root.chmod(path, mode);
}

function seed(path, content) {
  seedAs(alice, path, content);
}

function seedAs(who, path, content) {
  who.writeFile(path, content, { mode: 0o644 });
}
