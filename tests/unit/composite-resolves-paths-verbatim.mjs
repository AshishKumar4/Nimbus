#!/usr/bin/env bun
// A mount that resolves its own paths (MountOptions.resolvesPaths) is handed
// the rest of a path as written, for its backend to walk as a kernel does
// (Kinu ask 58; design-resolving-mount-operands.md). The namespace keeps the
// names it owns: the mount point, a nested mount point or a directory above
// one met on the way, and a `..` that climbs past the mount's root.
//
// The backend is a recording adapter over a CompositeVFS that does not
// resolve its own paths, over a MemoryVFS: that composite's lookup is
// Linux's (links followed, ENOENT/ENOTDIR, a trailing slash, `..` after a
// link), on both faces, and it numbers no inodes here (stripped), so the
// namespace's own numbers are exercised. Checked, on both faces:
//   - every §3 example, as the exact operand the backend recorded;
//   - reads, stat, lstat, readdir and readdirStat (an entry's own stat
//     extends the directory's operand), realpath (it reads back the same
//     entry), a pin and its held file;
//   - creation through a link (writeFile, its parents, mkdir and mkdir -p),
//     a create with parents and a trailing slash (the name is not made a
//     directory), unlink, rename (both operands), copy, and rm -r (its
//     report named from the mount's root);
//   - two spellings that reach different files never share an inode number;
//   - a root that resolves its own paths;
//   - a process's walk beneath a preopen (walkBeneath) gives the namespace
//     the name as written past the point it hands over, after a link it
//     followed on the way in, with a trailing slash kept; on both process
//     faces, a no-follow last name keeps its slash, and a directory opened
//     past a `..` is where its descriptor's relative and beneath lookups
//     start;
//   - final separators reach the backend on mutations (mkdir, rmdir,
//     unlink), a no-follow `/` follows the link (its own name and number),
//     and a rename between two files of one lexical name happens.
//
// Red before: the namespace collapsed `.`, `..` and the trailing slash, so
// the backend read /f for /m/missing/../f, and /f for /m/link/../f (the
// link leads to /a/b, whose parent holds another f).
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { walkBeneath } from '../../packages/core/src/runtime/beneath-walk.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A backend that records each call (`op path`), over a non-resolving CompositeVFS over `memory`, its stats numbering no inodes. `sync`: it has a synchronous face. */
function recording(memory, { sync: synchronous = true } = {}) {
  const inner = new CompositeVFS(memory);
  const asked = [];
  const strip = (value) => (value !== null && typeof value === 'object' && 'type' in value && 'ino' in value ? { ...value, ino: undefined } : value);
  const face = (target, sync) => new Proxy(target, {
    get(t, key) {
      if (key === 'sync') return sync || !synchronous ? undefined : face(t.sync, true);
      const value = t[key];
      if (typeof value !== 'function') return value;
      // A principal's view of it is the same adapter (its faces, its record).
      if (key === 'as') return (...args) => face(value.apply(t, args), sync);
      return (...args) => {
        asked.push(`${String(key)} ${args[0]}${typeof args[1] === 'string' ? ` ${args[1]}` : ''}`);
        const out = value.apply(t, args);
        return out instanceof Promise ? out.then(strip) : strip(out);
      };
    },
  });
  return { vfs: face(inner, false), asked, memory };
}

/** The backend's tree: /link leads to /a/b, so /link/../f is /a/f, not /f; /toB leads to /a/b too. */
function tree() {
  const memory = new MemoryVFS();
  memory.mkdir('/a/b', { recursive: true });
  memory.mkdir('/dir', { recursive: true });
  memory.writeFile('/a/f', enc.encode('a/f'));
  memory.writeFile('/a/b/c', enc.encode('a/b/c'));
  memory.writeFile('/f', enc.encode('f'));
  memory.writeFile('/dir/g', enc.encode('g'));
  memory.symlink('/a/b', '/link');
  memory.symlink('/a/b', '/toB');
  // A relative link beside /a/b/c, and a decoy where the lexical name /b would lead.
  memory.symlink('c', '/a/b/toC');
  memory.mkdir('/b', { recursive: true });
  memory.writeFile('/b/c', enc.encode('decoy'));
  return memory;
}

const outcome = async (run) => {
  try { const value = await run(); return value instanceof Uint8Array ? dec.decode(value) : value; } catch (error) { return error.code ?? String(error); }
};

/** The namespace: / (a MemoryVFS holding /x), /m (resolving, recorded), /m/n (a mount nested in it), /m/a/n (a mount below a directory /m/a). */
function namespace() {
  const root = new MemoryVFS();
  root.writeFile('/x', enc.encode('namespace x'));
  const m = recording(tree());
  const nested = new MemoryVFS();
  nested.writeFile('/f', enc.encode('nested f'));
  const vfs = new CompositeVFS(root);
  vfs.mount('/m', m.vfs, { resolvesPaths: true });
  vfs.mount('/m/n', nested);
  vfs.mount('/m/a/n', new MemoryVFS());
  return { vfs, m };
}

for (const face of ['async', 'sync']) {
  const { vfs, m } = namespace();
  const ns = face === 'sync' ? vfs.sync : vfs;
  /** `run`'s outcome, and what the backend was asked by `op` meanwhile. */
  const call = async (op, run) => {
    m.asked.length = 0;
    const got = await outcome(run);
    return { got, asked: m.asked.filter((line) => line.startsWith(`${op} `)) };
  };

  // §3: what the backend is handed, exactly.
  const reads = [
    ['/m/missing/../f', 'ENOENT', ['readFile /missing/../f']],
    ['/m/./f', 'f', ['readFile /./f']],
    ['/m//f', 'f', ['readFile //f']],
    ['/m/f/', 'ENOTDIR', ['readFile /f/']],
    ['/m/link/../f', 'a/f', ['readFile /link/../f']],
    ['/m/dir/./g', 'g', ['readFile /dir/./g']],
    ['/m/n/../f', 'f', ['readFile /f']],
    ['/m/n/../missing/../f', 'ENOENT', ['readFile /missing/../f']],
    ['/m/a/link/../f', 'ENOENT', ['readFile /a/link/../f']],
    ['/m/a/b/../f', 'a/f', ['readFile /a/b/../f']],
    ['/m/n/../../x', 'namespace x', []],
    ['/m/x/../n/f', 'nested f', []],
  ];
  for (const [path, want, asked] of reads) {
    assert.deepEqual(await call('readFile', () => ns.readFile(path)), { got: want, asked }, `${face} readFile ${path}`);
  }
  // Landing on the point is the namespace's: the mount's root.
  assert.equal((await ns.stat('/m/dir/..'))?.type, 'directory');

  // stat and lstat: absent as the backend walks it; a link found, not followed.
  assert.deepEqual(await call('stat', () => ns.stat('/m/missing/../f')), { got: null, asked: ['stat /missing/../f'] });
  assert.equal((await ns.stat('/m/link/../f'))?.size, 3);
  assert.equal((await ns.stat('/m/dir/./../link', { follow: false }))?.type, 'symlink');

  // readdir, and readdirStat, whose entries' stats extend the directory's operand.
  assert.deepEqual(await call('readdir', () => ns.readdir('/m/f/')), { got: 'ENOTDIR', asked: ['readdir /f/'] });
  if (face === 'async') {
    m.asked.length = 0;
    const listed = await vfs.readdirStat('/m/link/../b');
    assert.deepEqual(listed.map(({ name, stat }) => [name, stat.type]).sort(), [['c', 'file'], ['toC', 'symlink']]);
    assert.ok(m.asked.every((line) => !line.includes('/b/c') || line.includes('/link/../b/c')), `${m.asked}`);
  }

  // Two spellings of different files never share a number; one spelling keeps its own.
  const viaLink = await ns.stat('/m/link/../f');
  const plain = await ns.stat('/m/f');
  assert.notEqual(viaLink.ino, plain.ino);
  assert.equal((await ns.stat('/m/link/../f')).ino, viaLink.ino);
  assert.equal((await ns.stat('/m/./f')).ino, plain.ino, 'no `..`: the lexical name, one number');

  // realpath reads back the same entry; without a `..` it is the lexical name.
  const real = face === 'sync' ? vfs.realpath('/m/link/../f') : await vfs.realpathAsync('/m/link/../f');
  assert.equal(real, '/m/link/../f');
  assert.equal(await outcome(() => ns.readFile(real)), 'a/f');
  assert.equal(face === 'sync' ? vfs.realpath('/m/dir/./g') : await vfs.realpathAsync('/m/dir//g'), '/m/dir/g');

  // Not followed, a final `/` follows the link: its name keeps the `/`, and its number is its own.
  assert.equal((await ns.stat('/m/toB/', { follow: false }))?.type, 'directory');
  assert.equal((await ns.stat('/m/toB', { follow: false }))?.type, 'symlink');
  assert.notEqual((await ns.stat('/m/toB/', { follow: false })).ino, (await ns.stat('/m/toB', { follow: false })).ino);
  const linkDir = await vfs.pin('/m/toB/', { follow: false, sync: face === 'sync' });
  assert.equal(linkDir.name, '/m/toB/');
  assert.equal((await linkDir.stat())?.type, 'directory');
  // Final separators reach the backend on every mutation too.
  assert.deepEqual(await call('mkdir', () => ns.mkdir(`/m/${face}-slashed/`)), { got: undefined, asked: [`mkdir /${face}-slashed/`] });
  assert.deepEqual(await call('rmdir', () => ns.rmdir(`/m/${face}-slashed/`)), { got: undefined, asked: [`rmdir /${face}-slashed/`] });
  assert.deepEqual(await call('unlink', () => ns.unlink('/m/f/')), { got: 'ENOTDIR', asked: ['unlink /f/'] });
  assert.equal(dec.decode(m.memory.readFile('/f')), 'f');
  // A rename onto the name of another file: two spellings, one lexical name, both observed.
  m.memory.writeFile('/a/g2', enc.encode('a/g2'));
  m.memory.writeFile('/g2', enc.encode('g2'));
  assert.deepEqual(await call('rename', () => ns.rename('/m/link/../g2', '/m/g2')), { got: undefined, asked: ['rename /link/../g2 /g2'] });
  assert.equal(dec.decode(m.memory.readFile('/g2')), 'a/g2');

  // A pin holds the name it was found at, as written past a `..`; its file is the backend's /a/f.
  const pinned = await vfs.pin('/m/link/../f', { follow: true, sync: face === 'sync' });
  assert.equal(pinned.name, '/m/link/../f');
  const held = await pinned.hold({ read: true, write: false }, (await pinned.stat()).ino);
  assert.equal(held.name, '/m/link/../f');
  assert.equal(dec.decode(await held.readAll()), 'a/f');
  await held.close();

  // Creation through a link lands where the link leads.
  const made = `${face}-made`;
  assert.deepEqual(await call('writeFile', () => ns.writeFile(`/m/link/../${made}`, enc.encode('new'))), { got: undefined, asked: [`writeFile /link/../${made}`] });
  assert.equal(dec.decode(m.memory.readFile(`/a/${made}`)), 'new');
  assert.equal(m.memory.stat(`/${made}`), null);
  // A write that makes its parents (the awaiting face's makeTree; the synchronous face leaves `parents` to the backend).
  if (face === 'async') {
    await ns.writeFile(`/m/link/../${made}-deep/f`, enc.encode('deep'), { parents: true });
    assert.equal(dec.decode(m.memory.readFile(`/a/${made}-deep/f`)), 'deep');
    // A trailing slash: the parent is made, the name is not made a directory, and the write is refused.
    assert.notEqual(await outcome(() => ns.writeFile(`/m/${made}-slash/f/`, enc.encode('x'), { parents: true })), undefined);
    assert.equal(m.memory.stat(`/${made}-slash`)?.type, 'directory');
    assert.equal(m.memory.stat(`/${made}-slash/f`), null);
  }
  await ns.mkdir(`/m/link/../${made}-dir`);
  assert.equal(m.memory.stat(`/a/${made}-dir`)?.type, 'directory');
  assert.deepEqual(await call('mkdir', () => ns.mkdir(`/m/link/../${made}-p/q`, { recursive: true })), { got: undefined, asked: [`mkdir /link/../${made}-p/q`] });
  assert.equal(m.memory.stat(`/a/${made}-p/q`)?.type, 'directory');

  // rename: both operands as written.
  assert.deepEqual(await call('rename', () => ns.rename(`/m/link/../${made}`, `/m/link/../${made}-moved`)), { got: undefined, asked: [`rename /link/../${made} /link/../${made}-moved`] });
  assert.equal(dec.decode(m.memory.readFile(`/a/${made}-moved`)), 'new');
  assert.deepEqual(await call('unlink', () => ns.unlink(`/m/link/../${made}-moved`)), { got: undefined, asked: [`unlink /link/../${made}-moved`] });
  assert.equal(m.memory.stat(`/a/${made}-moved`), null);

  // copy within the mount: the backend's own, both operands as written.
  if (face === 'async') {
    await vfs.copy('/m/link/../f', '/m/link/../copied');
    assert.equal(dec.decode(m.memory.readFile('/a/copied')), 'a/f');
  }

  // rm -r through a link: what it reports is named from the mount's root.
  const removal = await ns.removeRecursive(`/m/link/../${made}-p`);
  assert.equal(m.memory.stat(`/a/${made}-p`), null);
  assert.deepEqual(removal.failures, []);
  assert.deepEqual(removal.removed, [`/m/a/${made}-p`]);
}

// A copy into itself through spellings the backend walks, where the backend has
// no copy of its own: refused by name before anything is made, never unbounded.
{
  const m = recording(tree());
  const vfs = new CompositeVFS(new MemoryVFS());
  const noCopy = new Proxy(m.vfs, { get: (t, key) => (key === 'copy' ? undefined : t[key]) });
  vfs.mount('/m', noCopy, { resolvesPaths: true });
  m.memory.mkdir('/src/inner', { recursive: true });
  m.memory.mkdir('/a/src/inner', { recursive: true });
  for (const [from, to, code] of [
    ['/m/src', '/m/src/copy/', 'EINVAL'],
    ['/m/dir/../src', '/m/src/copy', 'EINVAL'],
    // Physically into itself under another name: /link/../src is /a/src.
    ['/m/link/../src', '/m/a/src/copy', 'ENOTSUP'],
  ]) {
    assert.equal(await outcome(() => vfs.copy(from, to, { recursive: true })), code, `${from} -> ${to}`);
    assert.equal(m.memory.stat('/src/copy'), null);
    assert.equal(m.memory.stat('/a/src/copy'), null);
  }
  // A file copied through such a name is copied.
  m.memory.writeFile('/a/src/file', enc.encode('a/src/file'));
  await vfs.copy('/m/link/../src/file', '/m/copied-file');
  assert.equal(dec.decode(m.memory.readFile('/copied-file')), 'a/src/file');
}

// A root that resolves its own paths is handed the rest from `/`.
{
  const m = recording(tree());
  const vfs = new CompositeVFS(m.vfs, { resolvesPaths: true });
  for (const [path, want, asked] of [
    ['/missing/../f', 'ENOENT', ['readFile /missing/../f']],
    ['/link/../f', 'a/f', ['readFile /link/../f']],
    ['/f', 'f', ['readFile /f']],
    ['//f', 'f', ['readFile //f']],
    // At `/` a `..` climbs nowhere: the backend walks it.
    ['/../missing/../f', 'ENOENT', ['readFile /../missing/../f']],
    ['/../f', 'f', ['readFile /../f']],
  ]) {
    m.asked.length = 0;
    assert.equal(await outcome(() => vfs.readFile(path)), want, path);
    assert.deepEqual(m.asked.filter((line) => line.startsWith('readFile ')), asked, path);
  }
  assert.equal(await vfs.realpathAsync('/f'), '/f');
  const first = await vfs.stat('/f');
  assert.equal((await vfs.stat('/f')).ino, first.ino, 'a root file keeps its number');
}

// A process's two faces: their walks hand the namespace the name as written,
// a last name not followed included, and a directory opened past a `..` is
// where its descriptor's lookups start.
for (const face of ['synchronous', 'awaiting']) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const m = recording(tree(), { sync: face === 'synchronous' });
  files.vfs.mount('/m', m.vfs, { resolvesPaths: true });
  const bound = files.bind({ pid: 7, cred: { uid: 0, gid: 0, groups: [], umask: 0o022 } });
  const fs = face === 'synchronous' ? bound.synchronous : bound;
  // The awaiting arm's mount is async-only: the synchronous face cannot reach it.
  if (face === 'awaiting') assert.notEqual(await outcome(() => bound.synchronous.readFile('/m/f')), 'f');
  assert.equal(await outcome(() => fs.unlink('/m/f/')), 'ENOTDIR', `${face}: unlink of a file with a final slash`);
  assert.equal(dec.decode(m.memory.readFile('/f')), 'f');
  assert.equal(await outcome(() => fs.readFile('/m/link/../f')), 'a/f', `${face}: a read through a link's ..`);
  assert.equal((await fs.stat('/m/toB/', { followSymlinks: false }))?.type, 'directory', `${face}: lstat with a final slash`);
  const dir = await fs.open('/m/link/../b', { read: true, directory: true });
  assert.equal(await outcome(() => fs.readFile({ directory: dir.id, path: 'c' })), 'a/b/c', `${face}: relative to the directory`);
  assert.equal(await outcome(() => fs.readFile({ directory: dir.id, path: 'c', beneath: true })), 'a/b/c', `${face}: beneath the directory`);
  // A relative link beneath it is followed from it, not from its lexical name (/b holds a decoy c).
  assert.equal(await outcome(() => fs.readFile({ directory: dir.id, path: 'toC', beneath: true })), 'a/b/c', `${face}: a relative link beneath the directory`);
  await fs.close(dir.id);
  await files.releaseProcess(7);
  harness.db.close();
}

// A walk beneath a preopen hands the namespace the name as written past the point.
{
  const dir = { type: 'directory', mode: 0o755, uid: 0, gid: 0 };
  const walked = (name, links = {}) => {
    const walk = walkBeneath('', { root: '', path: name, beneath: true }, true, { uid: 0, gid: 0, groups: [] },
      (path) => path.startsWith('/m/'));
    for (let step = walk.next(); ;) {
      if (step.done) return step.value;
      const lookup = step.value;
      step = walk.next('readlink' in lookup ? links[lookup.readlink] : lookup.readlink === undefined && links[lookup.stat] !== undefined ? { type: 'symlink' } : dir);
    }
  };
  assert.deepEqual(walked('m/link/../f'), { reached: 'm/f', spelling: '/m/link/../f' });
  // A `.` on the namespace's own name is the walk's; past the point the rest is as written.
  assert.deepEqual(walked('m/./f/'), { reached: 'm/f', spelling: '/m/f/' });
  assert.deepEqual(walked('m/f/./g/'), { reached: 'm/f/g', spelling: '/m/f/./g/' });
  assert.deepEqual(walked('l/link/../f', { '/l': '/m' }), { reached: 'm/f', spelling: '/m/link/../f' });
  assert.deepEqual(walked('x/../y'), { reached: 'y', spelling: '/y' });
}

console.log('composite-resolves-paths-verbatim: ok');
