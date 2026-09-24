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
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
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

// ── chmod: the owner triad moves; nothing else widens ───────────────────────
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

// Narrowing is the owner making its own file more private, never a grant.
a.writeFile('/tmp/run.sh', 'x', { mode: 0o755 });
a.chmod('/tmp/run.sh', 0o700);
assert.equal(a.stat('/tmp/run.sh').mode & 0o7777, 0o700, 'chmod 700 narrows group and other');
a.writeFile('/tmp/key', 'k');
assert.equal(a.stat('/tmp/key').mode & 0o7777, 0o644);
a.chmod('/tmp/key', 0o600);
assert.equal(a.stat('/tmp/key').mode & 0o7777, 0o600, 'chmod 600 makes a key private');
// A's umask would mask 0666, so the kernel provisions the writable file.
root.writeFile('var/agents/a/tmp/shared', 's');
root.chmod('var/agents/a/tmp/shared', 0o666);
root.chown('var/agents/a/tmp/shared', A.uid, A.gid);
a.chmod('/tmp/shared', 0o644);
assert.equal(a.stat('/tmp/shared').mode & 0o7777, 0o644, 'go-w drops group and other write');
assert.throws(() => a.chmod('/tmp/shared', 0o664), /EPERM/, 'and the dropped write cannot come back');
assert.throws(() => a.chmod('/tmp/key', 0o640), /EPERM/, 'narrowed bits cannot come back');
assert.throws(() => a.chmod('/tmp/shared', 0o654), /EPERM/, 'nor can one it never had');
assert.equal(a.stat('/tmp/shared').mode & 0o7777, 0o644);

// Special bits: setuid/setgid grant, so they may be dropped but not added;
// sticky restricts others, so adding it narrows and dropping it would widen.
root.writeFile('var/agents/a/tmp/suid', 'x', { mode: 0o6755 });
root.chmod('var/agents/a/tmp/suid', 0o6755);
root.chown('var/agents/a/tmp/suid', A.uid, A.gid);
assert.throws(() => a.chmod('/tmp/run.sh', 0o2700), /EPERM/, 'setgid is a grant');
a.chmod('/tmp/suid', 0o2755);
assert.equal(a.stat('/tmp/suid').mode & 0o7777, 0o2755, 'dropping setuid narrows');
a.chmod('/tmp/suid', 0o700);
assert.equal(a.stat('/tmp/suid').mode & 0o7777, 0o700, 'dropping setgid narrows');
assert.throws(() => a.chmod('/tmp/suid', 0o4700), /EPERM/, 'and setuid cannot come back');
a.mkdir('/tmp/drop', { mode: 0o755 });
a.chmod('/tmp/drop', 0o1755);
assert.equal(a.stat('/tmp/drop').mode & 0o7777, 0o1755, 'adding sticky restricts others');
a.chmod('/tmp/drop', 0o1700);
assert.throws(() => a.chmod('/tmp/drop', 0o700), /EPERM/, 'dropping sticky would let others delete entries');
assert.equal(a.stat('/tmp/drop').mode & 0o7777, 0o1700);

// ── The same rule through an open descriptor (fchmod) ───────────────────────
//
// The bash runtime's fchmod import and the esbuild CLI reach chmod through a
// handle, not a path.
const aFs = new SqliteFilesystemAuthority(raw).bind({ pid: 5001, cred: A });
const keyFd = aFs.open('/tmp/key', { read: true });
assert.throws(() => aFs.fchmod(keyFd.id, 0o6777), /EPERM/, 'fchmod cannot widen either');
assert.equal(a.stat('/tmp/key').mode & 0o7777, 0o600);
aFs.fchmod(keyFd.id, 0o400);
assert.equal(a.stat('/tmp/key').mode & 0o7777, 0o400, 'fchmod narrows');
aFs.fchmod(keyFd.id, 0o600);
assert.equal(a.stat('/tmp/key').mode & 0o7777, 0o600, 'and the owner triad moves freely');
a.unlink('/tmp/key');
assert.throws(() => aFs.fchmod(keyFd.id, 0o666), /EPERM/, 'nor on a file that is already unlinked');
aFs.fchmod(keyFd.id, 0o400);
assert.equal(aFs.fstat(keyFd.id).mode & 0o7777, 0o400);
assert.equal(aFs.fstat(keyFd.id).mode & 0o170000, 0o100000, 'an unlinked file stays a regular file');
aFs.close(keyFd.id);
const dropFd = aFs.open('/tmp/drop', { read: true, directory: true });
assert.throws(() => aFs.fchmod(dropFd.id, 0o700), /EPERM/, 'fchmod cannot drop sticky');
assert.equal(a.stat('/tmp/drop').mode & 0o7777, 0o1700);
aFs.close(dropFd.id);

// ── Creation cannot grant setuid or setgid ──────────────────────────────────
//
// umask never masks 07000, so a confined creation masks it here; sticky only
// restricts others and is kept.
a.writeFile('/tmp/made-suid', 'x', { mode: 0o6777 });
assert.equal(a.stat('/tmp/made-suid').mode & 0o7777, 0o755, 'writeFile');
a.mkdir('/tmp/made-dir', { mode: 0o7777 });
assert.equal(a.stat('/tmp/made-dir').mode & 0o7777, 0o1755, 'mkdir');
aFs.close(aFs.open('/tmp/made-open', { write: true, create: true, mode: 0o6755 }).id);
assert.equal(a.stat('/tmp/made-open').mode & 0o7777, 0o755, 'open O_CREAT');
a.writeBatch({
  inodes: [{ path: '/tmp/made-batch', parentPath: '/tmp', isDir: false, size: 1, mtime: 1, mode: 0o6755, chunkCount: 1 }],
  chunks: [{ path: '/tmp/made-batch', chunkId: 0, data: new Uint8Array([1]) }],
});
assert.equal(a.stat('/tmp/made-batch').mode & 0o7777, 0o755, 'writeBatch');
root.writeFile('var/agents/a/tmp/kernel-suid', 'x', { mode: 0o4755 });
assert.equal(root.stat('var/agents/a/tmp/kernel-suid').mode & 0o7777, 0o4755, 'the kernel still can');

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

// Renames resolve both names through the principal's private /tmp mapping.
a.rename('/tmp/note.txt', '/tmp/renamed.txt');
assert.equal(a.exists('/tmp/note.txt'), false);
assert.equal(a.readFileString('/tmp/renamed.txt'), 'from A');
assert.equal(root.readFileString('var/agents/a/tmp/renamed.txt'), 'from A');
assert.equal(b.readFileString('/tmp/note.txt'), 'from B');
assert.equal(root.readFileString('tmp/note.txt'), 'shared');
a.writeFile('/tmp/replacement.txt', 'replacement');
a.rename('/tmp/replacement.txt', '/tmp/renamed.txt');
assert.equal(a.readFileString('/tmp/renamed.txt'), 'replacement');
a.rename('/tmp/sub', '/tmp/moved');
assert.equal(a.readFileString('/tmp/moved/deep.txt'), 'deep');
assert.throws(() => a.rename('/tmp/missing', '/tmp/missing'), /ENOENT/);
assert.throws(() => a.rename('/tmp/moved', '/tmp/moved/inside'), /EINVAL/);

// ── Release restores the shared view ────────────────────────────────────────
raw.releasePrincipal(A.uid);
assert.equal(
  raw.as(A).readFileString('/tmp/note.txt'),
  'shared',
  'a released principal is back on the shared scratch tree',
);

console.log('sqlite vfs confined principal: ok');
