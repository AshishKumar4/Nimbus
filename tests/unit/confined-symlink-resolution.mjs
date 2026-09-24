#!/usr/bin/env bun
// SECURITY: a confined principal's symlinks resolve in its own view.
//
// A confined principal's /tmp is private: it is stored at var/agents/a/tmp,
// and /tmp/x names var/agents/a/tmp/x. The resolver walked those storage keys,
// so it read a link's target against the key rather than against the name the
// caller used. A relative target with enough `..` climbed out of the private
// root (/tmp/out -> ../../../../tmp/x reached the SHARED tmp/x), and a link to
// a directory above it let any path go on into the shared tree. Reads and
// in-place writes followed. Resolution now walks the caller's own names: a
// relative target is read against the link's directory as the caller names
// it, an absolute one as the caller's own path, and only the final name is
// looked up in storage. Every link lands where naming its target directly
// would, and a link that climbs past `/` leads nowhere, in this view as in
// every other.
//
// Covered: the direct view (SqliteVFS.as), the runtime bridge that node and
// WASI processes go through, WASI's rooted lookups, open descriptions, mkdir,
// symlink, batch and stream writes, the legacy symlink registry, and the
// unconfined callers whose resolution must not change.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const PLAIN = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const PRIVATE_ROOT = 'var/agents/a/tmp';
const enc = new TextEncoder();
const dec = new TextDecoder();

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);

root.mkdir('tmp', { mode: 0o1777 });
root.chmod('tmp', 0o1777);
root.mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o755 });
for (const dir of ['var', 'var/agents', 'var/agents/a']) root.chmod(dir, 0o755);
root.chmod(PRIVATE_ROOT, 0o700);
root.chown(PRIVATE_ROOT, A.uid, A.gid);
raw.confinePrincipal(A.uid, PRIVATE_ROOT);

root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', PLAIN.uid, PLAIN.gid);
// The shared tree the escapes reached. shared.txt is writable by anyone and
// pub/ is a non-sticky world-writable directory, so an escaped write, create
// or unlink would be permitted: only the resolution stands in the way.
root.writeFile('tmp/shared.txt', 'SHARED');
root.chown('tmp/shared.txt', PLAIN.uid, PLAIN.gid);
root.chmod('tmp/shared.txt', 0o666);
root.mkdir('tmp/pub');
root.chmod('tmp/pub', 0o777);
root.writeFile('tmp/pub/victim', 'VICTIM');
root.chown('tmp/pub/victim', PLAIN.uid, PLAIN.gid);
root.writeFile('home/user/notes.txt', 'NOTES');
root.chown('home/user/notes.txt', PLAIN.uid, PLAIN.gid);

const a = raw.as(A);
const plain = raw.as(PLAIN);
const authority = new SqliteFilesystemAuthority(raw);
const aFs = authority.bind({ pid: 7001, cred: A });
const plainFs = authority.bind({ pid: 7002, cred: PLAIN });

// Links A made in its own /tmp. The first four climb out of the private root
// in storage terms (four `..` from var/agents/a/tmp reach `/`); in A's view,
// where /tmp is one level down, they climb past `/`.
a.symlink('../../../../tmp/shared.txt', '/tmp/rel');
a.symlink('../../../..', '/tmp/up');
a.symlink('../../../../tmp', '/tmp/tmpdir');
a.symlink('../../../../tmp/plink', '/tmp/probe');
// These reach A's own root, relatively and absolutely, and its own /tmp.
a.symlink('..', '/tmp/up1');
a.symlink('/', '/tmp/root');
a.symlink('/tmp/shared.txt', '/tmp/abs');
// Links the session user left where A can follow them, and one in the shared
// tmp that the climbing /tmp/probe reached for.
plain.symlink('../../tmp/shared.txt', '/home/user/into-tmp');
plain.symlink('../../tmp', '/home/user/tmp-dir');
plain.symlink('/home/user/notes.txt', '/tmp/plink');

const sharedIntact = () => {
  assert.equal(root.readFileString('tmp/shared.txt'), 'SHARED', 'the shared tmp/shared.txt was changed');
  assert.equal(root.readFileString('tmp/pub/victim'), 'VICTIM', 'the shared tmp/pub/victim was changed');
  const shared = root.readdir('tmp').map((entry) => entry.name).sort();
  assert.deepEqual(shared, ['plink', 'pub', 'shared.txt'], 'something was created in the shared tmp');
};
/**
 * The path does not exist for A: an ENOENT, or the bridge's null for one. A
 * lookup beneath a WASI preopen may instead refuse a climb above it.
 */
const absent = (label, run, codes = ['ENOENT']) => {
  let result;
  try {
    result = run();
  } catch (error) {
    assert.ok(codes.includes(error.code), `${label}: ${error.message}`);
    return;
  }
  assert.equal(result, null, `${label} reached ${JSON.stringify(result instanceof Uint8Array ? dec.decode(result) : result)}`);
};

// In A's view these climb past `/`, which leads nowhere.
const PAST_ROOT = ['/tmp/rel', '/tmp/up/tmp/shared.txt', '/tmp/tmpdir/shared.txt', '/tmp/probe'];
// And these all name A's own /tmp/shared.txt, which does not exist yet.
const IN_VIEW = [
  '/tmp/abs',
  '/tmp/root/tmp/shared.txt',
  '/tmp/up1/tmp/shared.txt',
  '/home/user/into-tmp',
  '/home/user/tmp-dir/shared.txt',
];

// ── Reads never reach the shared tree ─────────────────────────────────────
for (const path of [...PAST_ROOT, ...IN_VIEW]) {
  absent(`read ${path}`, () => a.readFile(path));
  absent(`stat ${path}`, () => a.stat(path));
  absent(`copyFile ${path}`, () => a.copyFile(path, '/tmp/copied'));
  absent(`open ${path}`, () => raw.openDescription(path, A, { read: true, write: false }));
  absent(`bridge read ${path}`, () => aFs.readFile(path));
  absent(`bridge stat ${path}`, () => aFs.stat(path));
  absent(`WASI read ${path}`, () => aFs.readFile({ root: '/', path: path.slice(1), beneath: true }), ['ENOENT', 'ENOTCAPABLE']);
}
assert.equal(a.exists('/tmp/up/tmp/shared.txt'), false);
assert.equal(a.exists('/tmp/root/tmp/pub/victim'), false);
absent('realpath /tmp/probe', () => aFs.realpath('/tmp/probe'));
absent('readdir /tmp/up', () => a.readdir('/tmp/up'));

// lstat and readlink report the link A wrote, byte for byte.
assert.equal(a.lstat('/tmp/rel').type, 'symlink');
assert.equal(a.readlink('/tmp/rel'), '../../../../tmp/shared.txt');
assert.equal(aFs.readlink('/tmp/up'), '../../../..');
assert.equal(aFs.stat('/tmp/root', { followSymlinks: false }).type, 'symlink');

// A directory link to the root lists A's own view, in which /tmp is its own.
assert.ok(aFs.readdir('/tmp/root').some((entry) => entry.name === 'home'));
const ownTmp = a.readdir('/tmp').map((entry) => entry.name).sort();
assert.deepEqual(a.readdir('/tmp/root/tmp').map((entry) => entry.name).sort(), ownTmp);
assert.deepEqual(a.readdir('/tmp/up1/tmp').map((entry) => entry.name).sort(), ownTmp);
assert.deepEqual(aFs.readdir('/home/user/tmp-dir').map((entry) => entry.name).sort(), ownTmp);
sharedIntact();

// ── Writes stay in A's view ───────────────────────────────────────────────
// Past `/` the two resolvers differ as they always have: the bridge stops
// `..` at the root, which makes these A's own /tmp/shared.txt, and SqliteVFS
// does not, which makes them missing. Neither reaches the shared tree.
for (const path of PAST_ROOT) {
  for (const [label, write] of [
    ['write', () => a.writeFile(path, 'escaped')],
    ['writeRange', () => a.writeRange(path, 0, enc.encode('E'))],
    ['truncate', () => a.truncate(path, 1)],
    ['open', () => raw.openDescription(path, A, { read: true, write: true }).close()],
    ['bridge write', () => aFs.writeFile(path, 'escaped')],
  ]) {
    try {
      write();
    } catch (error) {
      assert.equal(error.code, 'ENOENT', `${label} ${path}: ${error.message}`);
    }
    sharedIntact();
  }
}
a.unlink('/tmp/shared.txt');
for (const [index, path] of IN_VIEW.entries()) {
  a.writeFile(path, `A${index}`);
  sharedIntact();
  assert.equal(a.readFileString('/tmp/shared.txt'), `A${index}`, `write ${path} landed elsewhere`);
}
a.writeRange('/tmp/root/tmp/shared.txt', 0, enc.encode('R'));
a.truncate('/home/user/tmp-dir/shared.txt', 1);
aFs.writeFile('/tmp/up1/tmp/shared.txt', 'bridge');
{
  const fd = raw.openDescription('/home/user/into-tmp', A, { read: true, write: true });
  fd.write(0, enc.encode('FD'));
  fd.close();
}
sharedIntact();
assert.equal(a.readFileString('/tmp/shared.txt'), 'FDidge');

// ── Creates land in the directory a link names, never under the link ─────
// mkdir and symlink placed the new row at the key of the name as written, so
// through a link to a directory it went under the link: unreachable, and in
// PLAIN's home, a directory A cannot write.
a.writeFile('/tmp/root/tmp/planted.txt', 'mine');
a.mkdir('/tmp/up1/tmp/made');
a.mkdir('/home/user/tmp-dir/made-deep/inner', { recursive: true });
a.symlink('planted.txt', '/tmp/root/tmp/made-link');
a.symlink('planted.txt', '/home/user/tmp-dir/via-home-link');
aFs.writeFile('/home/user/tmp-dir/via-home.txt', 'mine');
aFs.mkdir('/tmp/root/tmp/bridge-dir');
sharedIntact();
for (const name of ['planted.txt', 'made', 'made-deep/inner', 'made-link', 'via-home-link', 'via-home.txt', 'bridge-dir']) {
  assert.ok(a.exists(`/tmp/${name}`), `${name} was not created in A's own /tmp`);
}
assert.equal(a.readFileString('/tmp/via-home-link'), 'mine');
for (const path of ['/tmp/up/tmp/x', '/tmp/tmpdir/x']) {
  assert.throws(() => a.writeFile(path, 'x'), { code: 'ENOENT' });
  assert.throws(() => a.mkdir(path), { code: 'ENOENT' });
  assert.throws(() => a.symlink('x', path), { code: 'ENOENT' });
}
assert.deepEqual(rows('home/user/tmp-dir/'), [], "a row was placed under the link in PLAIN's home");
assert.deepEqual(rows(`${PRIVATE_ROOT}/root/`), [], 'a row was placed under a link A made');
assert.deepEqual(rows(`${PRIVATE_ROOT}/up1/`), [], 'a row was placed under a link A made');

// ── Unlink, rmdir, rename and removal act on what the name resolves to ────
for (const path of ['/tmp/up/tmp/pub/victim', '/tmp/root/tmp/pub/victim', '/home/user/tmp-dir/pub/victim']) {
  assert.throws(() => a.unlink(path), { code: 'ENOENT' });
  assert.throws(() => aFs.unlink(path), { code: 'ENOENT' });
  assert.throws(() => a.rename(path, '/tmp/stolen'), { code: 'ENOENT' });
  assert.throws(() => a.removeRecursive(path.slice(0, path.lastIndexOf('/'))), { code: 'ENOENT' });
}
assert.throws(() => a.rename('/tmp/planted.txt', '/tmp/root/tmp/pub/dropped'), { code: 'ENOENT' });
sharedIntact();
a.rename('/tmp/root/tmp/planted.txt', '/tmp/up1/tmp/renamed.txt');
assert.equal(a.readFileString('/tmp/renamed.txt'), 'mine');
a.rmdir('/home/user/tmp-dir/made');
assert.equal(a.exists('/tmp/made'), false, 'rmdir through a link removed nothing');
a.unlink('/tmp/root/tmp/made-link');
assert.equal(a.exists('/tmp/made-link'), false);
sharedIntact();

// ── WASI: lookups rooted at a preopened /tmp, by path and by descriptor ───
// The link targets are A's names, so a link inside the preopen stays inside
// it, including one that leaves and comes back.
a.symlink('renamed.txt', '/tmp/inner');
a.symlink('../tmp/renamed.txt', '/tmp/back');
for (const name of ['inner', 'back']) {
  assert.equal(dec.decode(aFs.readFile({ root: '/tmp', path: name, beneath: true })), 'mine', name);
}
absent('WASI rel', () => aFs.readFile({ root: '/tmp', path: 'rel', beneath: true }), ['ENOENT', 'ENOTCAPABLE']);
{
  const dir = aFs.open('/tmp', { read: true, directory: true });
  for (const name of ['inner', 'back']) {
    assert.equal(dec.decode(aFs.readFile({ directory: dir.id, path: name, beneath: true })), 'mine', name);
  }
  aFs.close(dir.id);
}

// ── realpath and resolveSymlink name what A would name ────────────────────
assert.equal(aFs.realpath('/tmp/abs'), '/tmp/shared.txt');
assert.equal(aFs.realpath('/tmp/root/tmp/inner'), '/tmp/renamed.txt');
assert.equal(aFs.realpath('/home/user/tmp-dir/back'), '/tmp/renamed.txt');
assert.equal(aFs.realpath(`/${PRIVATE_ROOT}/inner`), '/tmp/renamed.txt', 'its own root, by storage name');
assert.equal(a.resolveSymlink('/tmp/up1/tmp/inner'), 'tmp/renamed.txt');

// ── Batch and stream writes land where their permission was checked ───────
// A batch places each entry at its literal path. When that path's parent is
// a link, the permission was checked on the link's target while the row went
// under the link: here, into PLAIN's home, which A cannot write.
function rows(prefix) {
  return harness.db.query('SELECT path FROM inodes WHERE path > ? AND path < ? ORDER BY path')
    .all(prefix, `${prefix.slice(0, -1)}0`).map((row) => row.path);
}
const batchFile = (path, parentPath) => ({ path, parentPath, isDir: false, size: 1, mtime: 1, mode: 0o644, chunkCount: 1 });
assert.throws(() => a.writeBatch({
  inodes: [batchFile('/home/user/tmp-dir/planted', '/home/user/tmp-dir')],
  chunks: [{ path: '/home/user/tmp-dir/planted', chunkId: 0, data: enc.encode('x') }],
}), { code: 'ENOTDIR' });
assert.throws(() => a.writeBatch({
  inodes: [batchFile('/tmp/root/batched', '/tmp/root')],
  chunks: [{ path: '/tmp/root/batched', chunkId: 0, data: enc.encode('x') }],
}), { code: 'ENOTDIR' });
assert.throws(() => a.mkdirBatch(['/home/user/tmp-dir/batch-dir']), { code: 'ENOTDIR' });
// A stream frames canonical paths, without the leading slash.
{
  const result = await a.writeStream(encodeWriteBatchStream({
    inodes: [batchFile('home/user/tmp-dir/streamed', 'home/user/tmp-dir')],
    chunks: [{ path: 'home/user/tmp-dir/streamed', chunkId: 0, data: enc.encode('x') }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ENOTDIR/);
}
{
  const result = await a.writeStream(encodeWriteBatchStream({
    inodes: [{ path: 'home/user/tmp-dir/sub', parentPath: 'home/user/tmp-dir', isDir: true, size: 0, mtime: 1, mode: 0o755, chunkCount: 0 }],
    chunks: [],
  }));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ENOTDIR/);
}
assert.deepEqual(rows('home/user/tmp-dir/'), [], "a row was planted under a link in PLAIN's home");
assert.deepEqual(rows(`${PRIVATE_ROOT}/root/`), [], 'a row was placed under a link A made');
// A batch into a real directory is unaffected.
a.writeBatch({ inodes: [batchFile('/tmp/batched', '/tmp')], chunks: [{ path: '/tmp/batched', chunkId: 0, data: enc.encode('b') }] });
assert.equal(a.readFileString('/tmp/batched'), 'b');
sharedIntact();

// ── The legacy symlink registry is read in A's view too ───────────────────
// Its keys are storage keys. An entry in the shared tmp is not A's, and one
// in A's own root is A's, under its own name.
root.writeFile('.nimbus-symlinks.json', JSON.stringify({
  'tmp/legacy-shared': '/home/user/notes.txt',
  [`${PRIVATE_ROOT}/legacy-mine`]: 'renamed.txt',
}));
assert.equal(aFs.readlink('/tmp/legacy-shared'), null);
assert.equal(aFs.readFile('/tmp/legacy-shared'), null);
assert.ok(!aFs.readdir('/tmp').some((entry) => entry.name === 'legacy-shared'));
assert.throws(() => aFs.unlink('/tmp/legacy-shared'), { code: 'ENOENT' });
assert.throws(() => aFs.rename('/tmp/legacy-shared', '/tmp/taken'), { code: 'ENOENT' });
assert.equal(plainFs.readlink('/tmp/legacy-shared'), '/home/user/notes.txt', 'the shared entry survived');
assert.equal(aFs.readlink('/tmp/legacy-mine'), 'renamed.txt');
assert.equal(dec.decode(aFs.readFile('/tmp/legacy-mine')), 'mine');
assert.ok(aFs.readdir('/tmp').some((entry) => entry.name === 'legacy-mine'));
root.unlink('.nimbus-symlinks.json');

// ── The listing reads each link's own target ──────────────────────────────
// It re-resolved the listed name, and a row no lookup reaches (one an older
// build left under a link) made every page from there throw.
harness.db.query(
  `INSERT INTO inodes (path, parent_path, kind, size, mtime, mode, chunk_count, ino)
   VALUES ('home/user/tmp-dir/stranded', 'home/user/tmp-dir', 2, 0, 1, ${0o120777}, 0, 999999)`,
).run();
assert.ok(root.list(null, 4096).entries.some((entry) => entry.path === 'home/user/tmp-dir/stranded'));
harness.db.query("DELETE FROM inodes WHERE path = 'home/user/tmp-dir/stranded'").run();

// ── Unconfined callers resolve exactly as before ──────────────────────────
plain.symlink('../home/user/notes.txt', '/tmp/p-rel');
plain.symlink('/', '/tmp/p-root');
plain.symlink('../../home/user/notes.txt', '/tmp/p-climb');
plain.symlink('p-rel', '/tmp/p-chain');
plain.symlink('p-loop', '/tmp/p-loop');
assert.equal(plain.readFileString('/home/user/into-tmp'), 'SHARED');
assert.equal(plain.readFileString('/home/user/tmp-dir/shared.txt'), 'SHARED');
assert.equal(plain.readFileString('/tmp/p-rel'), 'NOTES');
assert.equal(plain.readFileString('/tmp/p-root/home/user/notes.txt'), 'NOTES');
assert.equal(plain.readFileString('/tmp/p-chain'), 'NOTES');
assert.equal(plain.readFileString('/tmp/plink'), 'NOTES');
// Past `/`: a missing `..`, as it always has been.
assert.throws(() => plain.readFile('/tmp/p-climb'), { code: 'ENOENT' });
assert.throws(() => plain.readFile('/tmp/p-loop'), { code: 'ELOOP' });
assert.equal(plain.readlink('/tmp/p-climb'), '../../home/user/notes.txt');
assert.equal(plain.resolveSymlink('/tmp/p-chain'), 'home/user/notes.txt');
assert.equal(plainFs.realpath('/tmp/p-chain'), '/home/user/notes.txt');
assert.equal(plainFs.realpath('/tmp/p-root/tmp/p-rel'), '/home/user/notes.txt');
assert.equal(dec.decode(plainFs.readFile({ root: '/tmp', path: 'p-chain', beneath: false })), 'NOTES');
// The kernel follows A's links from their storage keys, as it always has: it
// has no private /tmp, so the relative climb reaches the shared tmp/shared.txt.
assert.equal(root.readlink(`${PRIVATE_ROOT}/rel`), '../../../../tmp/shared.txt');
assert.equal(root.readFileString(`${PRIVATE_ROOT}/rel`), 'SHARED');
assert.equal(root.readFileString('home/user/tmp-dir/shared.txt'), 'SHARED');
assert.equal(root.readFileString(`${PRIVATE_ROOT}/renamed.txt`), 'mine');

// ── For every caller, creating through a link lands in its target ─────────
// mkdir and symlink placed the row under the link, and a batch did the same;
// the link's own name then hid it. They now create inside the directory the
// link names, and a batch, which places rows literally, refuses.
plain.mkdir('/home/user/real');
plain.symlink('real', '/home/user/real-link');
plain.mkdir('/home/user/real-link/made');
plain.symlink('../notes.txt', '/home/user/real-link/lnk');
assert.equal(plain.readFileString('/home/user/real/lnk'), 'NOTES');
assert.deepEqual(plain.readdir('/home/user/real-link').map((entry) => entry.name), ['lnk', 'made']);
assert.throws(() => plain.writeBatch({
  inodes: [batchFile('/home/user/real-link/batched', '/home/user/real-link')],
  chunks: [{ path: '/home/user/real-link/batched', chunkId: 0, data: enc.encode('x') }],
}), { code: 'ENOTDIR' });
assert.deepEqual(rows('home/user/real-link/'), []);

console.log('confined-symlink-resolution: ok');
