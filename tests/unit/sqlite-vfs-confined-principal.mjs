#!/usr/bin/env bun
// A confined principal: `/tmp` is private, and `chmod` cannot widen past the
// principal's own triad.
//
// The two travel together because they answer one question — is this principal
// a guest in this filesystem — and both are OFF for anyone unregistered, which
// is what keeps the ordinary session user's `chmod 755 script.sh` working.
//
// `/tmp` is remapped at RESOLUTION rather than by a mount. A mount diverges
// the planes: the shell writing `/tmp/a` and the file API writing `/tmp/b`
// land in different trees under the same name. `resolvePath` already takes the
// credential, and every plane goes through it, so remapping there converges
// them. `TMPDIR` was not an option: nothing in the shipped surface reads it,
// and several places hardcode `/tmp` outright.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const B = Object.freeze({ uid: 5002, gid: 5002, groups: Object.freeze([5002]), umask: 0o022 });
const PLAIN = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);

root.mkdir('tmp', { mode: 0o1777 });
root.chmod('tmp', 0o1777);
root.mkdir('var/agents', { recursive: true, mode: 0o755 });
root.chmod('var', 0o755);
root.chmod('var/agents', 0o755);
for (const [who, key] of [[A, 'var/agents/a/tmp'], [B, 'var/agents/b/tmp']]) {
  root.mkdir(key, { recursive: true, mode: 0o755 });
  root.chmod(key.slice(0, key.lastIndexOf('/')), 0o755);
  // 0700 and owned by the principal: the remap decides which tree a name means,
  // ordinary Unix permissions decide who may read it. The caller provisions the
  // root, so it is the caller that has to get this right.
  root.chmod(key, 0o700);
  root.chown(key, who.uid, who.gid);
  raw.confinePrincipal(who.uid, key);
}

const a = raw.as(A);
const b = raw.as(B);
const plain = raw.as(PLAIN);

// ── One path, two principals, two files ─────────────────────────────────────
a.writeFile('/tmp/note.txt', 'from A');
b.writeFile('/tmp/note.txt', 'from B');
assert.equal(a.readFileString('/tmp/note.txt'), 'from A');
assert.equal(b.readFileString('/tmp/note.txt'), 'from B');
assert.equal(root.readFileString('var/agents/a/tmp/note.txt'), 'from A', 'A landed in its own root');
assert.equal(root.readFileString('var/agents/b/tmp/note.txt'), 'from B', 'B landed in its own root');
assert.equal(root.exists('tmp/note.txt'), false, 'and neither touched the shared tree');

// ── Every plane converges on the same bytes ─────────────────────────────────
//
// The measured failure of remapping at the mount layer was exactly this: two
// planes, one path, two files. readdir was the bypass that made it visible.
a.mkdir('/tmp/sub', { recursive: true });
a.writeFile('/tmp/sub/deep.txt', 'deep');
assert.equal(a.isDirectory('/tmp/sub'), true);
assert.deepEqual(
  a.readdir('/tmp').map((e) => e.name).sort(),
  ['note.txt', 'sub'],
  'readdir sees the private tree, not an empty shared one',
);
assert.deepEqual(b.readdir('/tmp').map((e) => e.name), ['note.txt'], "and not the other principal's");
assert.equal(a.stat('/tmp/note.txt').size, 'from A'.length);
assert.ok(a.revision('/tmp/note.txt') > 0, 'the revision counter follows the private path');

// ── An absolute symlink target is confined too ──────────────────────────────
//
// Otherwise a symlink stored inside the private tree but pointing at /tmp/x
// would read the shared one, which is the single way out.
a.symlink('/tmp/note.txt', '/tmp/link');
assert.equal(a.readFileString('/tmp/link'), 'from A');
root.writeFile('tmp/note.txt', 'shared');
assert.equal(a.readFileString('/tmp/link'), 'from A', 'the link never escapes to the shared tree');

// ── list() reports paths the caller can actually address ────────────────────
{
  const seen = a.list().entries.map((e) => e.path);
  assert.ok(seen.includes('tmp/note.txt'), 'a confined caller sees its own tree at /tmp');
  assert.ok(seen.includes('tmp/sub/deep.txt'), 'nested private entries are named too');
  assert.ok(
    !seen.some((path) => path === 'var/agents/a/tmp' || path.startsWith('var/agents/a/tmp/')),
    'and never under the raw storage key it cannot address',
  );
  assert.ok(
    !seen.some((path) => path.startsWith('var/agents/b/tmp/')),
    "nor inside another principal's tree, which its mode refuses anyway",
  );

  const kernelSeen = root.list().entries.map((e) => e.path);
  assert.ok(kernelSeen.includes('var/agents/a/tmp/note.txt'), 'the kernel sees storage as it is');
  assert.throws(() => a.readdir('var/agents/b/tmp'), /EACCES/, 'the remap is not the isolation; the mode is');
}

// ── chmod: the owner triad moves; nothing else does ─────────────────────────
a.writeFile('/tmp/build.sh', '#!/bin/sh\n');
const before = a.stat('/tmp/build.sh').mode & 0o7777;

a.chmod('/tmp/build.sh', (before & 0o7777) | 0o700);
assert.equal(a.stat('/tmp/build.sh').mode & 0o700, 0o700, 'u+x works, so a guest can run what it wrote');
assert.equal(
  a.stat('/tmp/build.sh').mode & 0o77,
  before & 0o77,
  'and the group and other triads are untouched',
);

assert.throws(() => a.chmod('/tmp/build.sh', 0o777), /EPERM/, '777 would widen past the principal');
assert.throws(() => a.chmod('/tmp/build.sh', 0o4700), /EPERM/, 'and so would setuid');
// Refused, not clamped: the file is exactly what it was before the refusal.
assert.equal(
  a.stat('/tmp/build.sh').mode & 0o7777,
  (before & 0o7777) | 0o700,
  'a refused chmod changes nothing at all',
);
assert.throws(() => a.chmod('/tmp/build.sh', 0o777), /use u\+x/, 'the refusal names the spelling that works');

// ── An unconfined principal is entirely unaffected ──────────────────────────
root.mkdir('home/plain', { recursive: true, mode: 0o755 });
root.chown('home/plain', PLAIN.uid, PLAIN.gid);
plain.writeFile('/tmp/shared-note.txt', 'plain');
assert.equal(root.readFileString('tmp/shared-note.txt'), 'plain', '/tmp is still /tmp for the session user');
plain.writeFile('home/plain/script.sh', '#!/bin/sh\n');
plain.chmod('home/plain/script.sh', 0o755);
assert.equal(
  plain.stat('home/plain/script.sh').mode & 0o7777,
  0o755,
  'chmod 755 is normal for an unregistered principal',
);

// ── Release restores the shared view ────────────────────────────────────────
raw.releasePrincipal(A.uid);
assert.equal(
  raw.as(A).readFileString('/tmp/note.txt'),
  'shared',
  'a released principal is back on the shared scratch tree',
);

console.log('sqlite vfs confined principal: ok');
