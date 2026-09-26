#!/usr/bin/env bun
// CompositeVFS, against the mounts Kinu actually has.
//
// Kinu's /pc (a device fleet: a source asked live on every call, absent when
// no device is connected, Promise-based, a ranged read, no rename) and
// /sandbox (a container: stat derived from the parent listing, so it cannot
// stat its own root; listings carry stats; a ranged read), and a per-agent
// table (one agent has a device, another does not), run through the
// behaviours of Kinu's tests/unit-vfs-mounts.test.ts on the new API:
// routing, ENXIO with the stated reason, EBUSY at mount points, EXDEV across
// mounts, native vs walked removal with a partial report, readRange
// pass-through or ENOTSUP, per-principal visibility, moveAcross rollback,
// the sync view, nested and synthesized mount points.

import assert from 'node:assert/strict';

const base = new URL('../../packages/core/src/vfs/', import.meta.url).pathname;
const { CompositeVFS, moveAcross, normalizePath } = await import(`${base}/composite.ts`);
const { MemoryVFS } = await import(`${base}/memory.ts`);
const { VfsError, isVfsError } = await import(`${base}/vfs-error.ts`);
const { exists, readText, writeText } = await import(`${base}/vfs.ts`);

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (text) => enc.encode(text);

/** Kinu's device VFS shape: async, no rename, a ranged read. */
function device(files) {
  const tree = new MemoryVFS({ uid: 501, gid: 20 });
  for (const [path, text] of Object.entries(files)) {
    tree.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
    tree.writeFile(path, bytes(text));
  }
  // Kinu's device VFS has no rmdir and no rename; its unlink removes an
  // empty directory too (device-tunnel-executor.ts).
  return {
    tree,
    stat: async (p, o) => tree.stat(p, o),
    readFile: async (p) => tree.readFile(p),
    readRange: async (p, o, l) => tree.readRange(p, o, l),
    writeFile: async (p, d) => tree.writeFile(p, d),
    readdir: async (p) => tree.readdir(p).map(({ name, type }) => ({ name, type })),
    mkdir: async (p, o) => tree.mkdir(p, o),
    unlink: async (p) => (tree.stat(p, { follow: false })?.type === 'directory' ? tree.rmdir(p) : tree.unlink(p)),
  };
}

/** Kinu's sandbox shape: stat is derived from the parent listing; the root has no parent. */
function sandbox(files) {
  const d = device(files);
  return {
    ...d,
    stat: async (p) => {
      if (p === '/') throw new VfsError('EIO', 'the container cannot stat its own root', p);
      const parent = p.slice(0, p.lastIndexOf('/')) || '/';
      const name = p.slice(p.lastIndexOf('/') + 1);
      const entry = d.tree.readdir(parent).find((e) => e.name === name);
      return entry ? { ...entry.stat, mtimeMs: 0 } : null;
    },
    readdir: async (p) => d.tree.readdir(p),
  };
}

/** Kinu's Mossaic /shared shape: native rename, rmdir and removeRecursive. */
function shared(files) {
  const d = device(files);
  return {
    ...d,
    rmdir: async (p) => d.tree.rmdir(p),
    rename: async (from, to) => d.tree.rename(from, to),
    removeRecursive: async (p) => d.tree.removeRecursive(p),
  };
}

async function code(promise) {
  try { await promise; return 'ok'; } catch (e) { return isVfsError(e) ? e.code : `not a VfsError: ${e}`; }
}
function codeSync(run) {
  try { run(); return 'ok'; } catch (e) { return isVfsError(e) ? e.code : `not a VfsError: ${e}`; }
}
const names = async (vfs, path) => (await vfs.readdir(path)).map((e) => e.name).sort();

const cases = {
  async 'routing: /pc and /sandbox trees at every depth, stats included'() {
    const pc = device({ '/home/dev/report.txt': 'from the machine', '/home/dev/src/app.ts': 'export {};' });
    const box = sandbox({ '/workspace/build.log': 'ok' });
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => pc);
    vfs.mount('/sandbox', () => box);
    assert.deepEqual(await names(vfs, '/pc/home/dev'), ['report.txt', 'src']);
    assert.equal((await vfs.stat('/pc/home/dev/src')).type, 'directory');
    assert.equal((await vfs.stat('/pc/home/dev/report.txt')).type, 'file');
    assert.deepEqual(await names(vfs, '/sandbox/workspace'), ['build.log']);
    // The container cannot stat its root; the mount point is a directory anyway.
    assert.equal((await vfs.stat('/sandbox')).type, 'directory');
    assert.equal(await readText(vfs, '/pc/home/dev/report.txt'), 'from the machine');
    await writeText(vfs, '/pc/home/dev/out.txt', 'written through');
    assert.equal(dec.decode(pc.tree.readFile('/home/dev/out.txt')), 'written through');
    await vfs.mkdir('/pc/home/dev/build', { recursive: true });
    assert.equal((await vfs.stat('/pc/home/dev/build')).type, 'directory');
    await vfs.unlink('/pc/home/dev/out.txt');
    assert.equal(await exists(vfs, '/pc/home/dev/out.txt'), false);
  },

  async 'only a whole segment routes, and .. is resolved in the namespace'() {
    const root = new MemoryVFS();
    root.mkdir('/pcs'); root.writeFile('/pcs/x', bytes('root'));
    const vfs = new CompositeVFS(root);
    vfs.mount('/pc', () => device({ '/x': 'device' }));
    assert.equal(await readText(vfs, '/pcs/x'), 'root');
    assert.equal(await readText(vfs, '/pc/x'), 'device');
    // POSIX: /pc/.. is the parent of the mount point, as on Linux. (Kinu
    // refused this with EPERM; the principal's own permissions apply at the
    // target, so nothing escapes.)
    assert.equal(await readText(vfs, '/pc/../pcs/x'), 'root');
    assert.equal(normalizePath('pc//a/./b/../c'), '/pc/a/c');
  },

  async 'an absent mount is ENXIO with its reason, stats as nothing, and is not listed'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => null, { absentReason: () => 'no device connected' });
    for (const attempt of [
      () => vfs.readdir('/pc'), () => vfs.readFile('/pc/x'), () => vfs.writeFile('/pc/x', bytes('data')),
      () => vfs.unlink('/pc/x'), () => vfs.mkdir('/pc/x'), () => vfs.mkdir('/pc', { recursive: true }),
      () => vfs.writeFileIfRevision('/pc/x', new Uint8Array(), 1), () => vfs.readRange('/pc/x', 0, 1),
    ]) {
      let error;
      try { await attempt(); } catch (e) { error = e; }
      assert.ok(isVfsError(error, 'ENXIO'), `${attempt}: ${error}`);
      assert.match(error.message, /\/pc — no device connected/);
    }
    assert.equal(await vfs.stat('/pc'), null);
    assert.equal(await exists(vfs, '/pc/x'), false);
    assert.ok(!(await names(vfs, '/')).includes('pc'), 'the root lists only live mounts');
  },

  async 'a device connecting mid-session is seen on the next call'() {
    let connected = null;
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => connected, { absentReason: () => 'no device connected' });
    assert.equal(await code(vfs.readFile('/pc/a')), 'ENXIO');
    connected = device({ '/a': 'hello' });
    assert.equal(await readText(vfs, '/pc/a'), 'hello');
    assert.ok((await names(vfs, '/')).includes('pc'));
    connected = null;
    assert.equal(await vfs.stat('/pc/a'), null);
  },

  async 'mount points are immutable; mkdir -p of one is a no-op'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => device({ '/a': 'x' }));
    assert.equal(await code(vfs.unlink('/pc')), 'EISDIR', 'unlink(2) refuses a directory first');
    assert.equal(await code(vfs.rmdir('/pc')), 'EBUSY');
    assert.equal(await code(vfs.rename('/pc', '/elsewhere')), 'EBUSY');
    assert.equal(await code(vfs.removeRecursive('/pc')), 'EBUSY');
    assert.equal(await code(vfs.mkdir('/pc')), 'EBUSY');
    assert.equal(await code(vfs.mkdir('/pc', { recursive: true })), 'ok');
    assert.equal(await code(vfs.writeFile('/pc', bytes('x'))), 'EBUSY');
    assert.equal(await code(vfs.removeRecursive('/')), 'EBUSY', 'something is mounted beneath it');
    // The root is this namespace's: EBUSY for every change of it but a mode's.
    for (const attempt of [vfs.rmdir('/'), vfs.writeFile('/', bytes('x')), vfs.mkdir('/'), vfs.rename('/', '/r')]) {
      assert.equal(await code(attempt), 'EBUSY');
    }
    assert.equal(await code(vfs.unlink('/')), 'EISDIR');
    assert.equal(await code(vfs.mkdir('/', { recursive: true })), 'ok');
    // ENXIO comes first: a mount point absent for this principal is not
    // there for it at all, so there is nothing for it to be busy with.
    vfs.mount('/gone', () => null);
    for (const attempt of [vfs.unlink('/gone'), vfs.rmdir('/gone'), vfs.writeFile('/gone', bytes('x')), vfs.mkdir('/gone'), vfs.removeRecursive('/gone'), vfs.rename('/gone', '/elsewhere')]) {
      assert.equal(await code(attempt), 'ENXIO');
    }
    // A live mount nested under an absent one is unreachable too.
    vfs.mount('/gone/inner', new MemoryVFS());
    assert.equal(await code(vfs.readdir('/gone/inner')), 'ENXIO');
    assert.equal(await vfs.stat('/gone/inner'), null);
  },

  async 'rename: native within a mount, EXDEV across, and nothing moves on a refusal'() {
    const drive = shared({ '/w/a.txt': 'A' });
    const pc = device({ '/b.txt': 'B' });
    const root = new MemoryVFS();
    root.writeFile('/c.txt', bytes('C'));
    const vfs = new CompositeVFS(root);
    vfs.mount('/shared', () => drive);
    vfs.mount('/pc', () => pc);
    await vfs.rename('/shared/w/a.txt', '/shared/w/renamed.txt');
    assert.deepEqual(await names(vfs, '/shared/w'), ['renamed.txt']);
    assert.equal(await code(vfs.rename('/shared/w/renamed.txt', '/pc/x.txt')), 'EXDEV');
    assert.equal(await code(vfs.rename('/c.txt', '/pc/c.txt')), 'EXDEV');
    assert.equal(await code(vfs.rename('/pc/b.txt', '/c2.txt')), 'EXDEV');
    assert.deepEqual(await names(vfs, '/shared/w'), ['renamed.txt']);
    assert.equal(await readText(vfs, '/c.txt'), 'C');
    // rename(2) resolves both parents first: a file used as a directory on
    // either side is ENOTDIR before the source's ENOENT, EXDEV or EBUSY.
    assert.equal(await code(vfs.rename('/missing', '/c.txt/x')), 'ENOTDIR');
    // The walk comes first (Linux lookup: a file used as a directory is
    // ENOTDIR), then this layer's refusals (ENXIO, EBUSY, EXDEV).
    assert.equal(await code(vfs.rename('/c.txt/x', '/pc/y')), 'ENOTDIR');
    assert.equal(await code(vfs.rename('/c.txt/x', '/pc')), 'ENOTDIR');
    assert.equal(await code(vfs.rename('/missing/x', '/pc/y')), 'ENOENT');
    assert.equal(await code(vfs.rename('/c.txt', '/pc/y')), 'EXDEV');
    // The device has no rename: EXDEV (mv copies), never an emulated move.
    assert.equal(await code(vfs.rename('/pc/b.txt', '/pc/b2.txt')), 'EXDEV');
    assert.equal(await readText(vfs, '/pc/b.txt'), 'B');
  },

  async 'moveAcross copies, confirms, then removes; a failure puts both sides back'() {
    const pc = device({ '/b.txt': 'B' });
    const box = sandbox({ '/w/keep.txt': 'old' });
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => pc);
    vfs.mount('/sandbox', () => box);
    await moveAcross(vfs, '/pc/b.txt', '/sandbox/w/b.txt');
    assert.equal(await readText(vfs, '/sandbox/w/b.txt'), 'B');
    assert.equal(await exists(vfs, '/pc/b.txt'), false);
    // The source cannot be removed: the destination gets its old bytes back.
    const stuck = { ...device({ '/s.txt': 'S' }) };
    stuck.unlink = async (p) => { throw new VfsError('EACCES', 'held open', p); };
    vfs.mount('/stuck', () => stuck);
    assert.equal(await code(moveAcross(vfs, '/stuck/s.txt', '/sandbox/w/keep.txt')), 'EACCES');
    assert.equal(await readText(vfs, '/sandbox/w/keep.txt'), 'old');
    assert.equal(await readText(vfs, '/stuck/s.txt'), 'S');
    assert.equal(await code(moveAcross(vfs, '/sandbox/w', '/pc/w')), 'EISDIR');
  },

  async 'removeRecursive: native where the backend has it, walked where not, with a partial report'() {
    const root = new MemoryVFS();
    root.mkdir('/t/a', { recursive: true }); root.writeFile('/t/a/f', bytes('x'));
    const vfs = new CompositeVFS(root);
    await vfs.removeRecursive('/t');
    assert.equal(await exists(vfs, '/t'), false);
    const pc = device({ '/d/e/f.txt': 'f', '/d/g.txt': 'g' });
    vfs.mount('/pc', () => pc);
    await vfs.removeRecursive('/pc/d');
    assert.equal(await exists(vfs, '/pc/d'), false);
    const drive = shared({ '/d/x': 'x' });
    const native = drive.removeRecursive;
    let nativeCalls = 0;
    drive.removeRecursive = async (p) => { nativeCalls++; return native(p); };
    vfs.mount('/shared', () => drive);
    assert.deepEqual(await vfs.removeRecursive('/shared/d'), { removed: ['/shared/d'], kept: [], failures: [] });
    assert.equal(nativeCalls, 1, 'native removal where the backend has it: no walk, the operand is the report');
    const flaky = device({ '/d/ok.txt': '1', '/d/bad.txt': '2' });
    const unlink = flaky.unlink;
    flaky.unlink = async (p) => { if (p.endsWith('bad.txt')) throw new VfsError('EACCES', 'no', p); return unlink(p); };
    vfs.mount('/flaky', () => flaky);
    // A walk carries on past a failure, as rm -r does, and reports exactly:
    // removed subtrees by their roots, what is still there, and why.
    const report = await vfs.removeRecursive('/flaky/d');
    assert.deepEqual(report.removed, ['/flaky/d/ok.txt']);
    assert.deepEqual(report.kept, ['/flaky/d', '/flaky/d/bad.txt']);
    assert.deepEqual(report.failures.map((f) => [f.path, f.error.code]), [['/flaky/d/bad.txt', 'EACCES']]);
    assert.equal(await vfs.removeRecursive('/flaky/nothing').catch((e) => e.code), 'ENOENT');
  },

  async 'rmdir on a backend without it: an emptiness check, then unlink'() {
    const pc = device({ '/d/f.txt': 'f' });
    pc.tree.mkdir('/empty');
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => pc);
    assert.equal(await code(vfs.rmdir('/pc/d')), 'ENOTEMPTY');
    assert.equal(await code(vfs.rmdir('/pc/d/f.txt')), 'ENOTDIR');
    assert.equal(await code(vfs.rmdir('/pc/empty')), 'ok');
    assert.equal(await exists(vfs, '/pc/empty'), false);
  },

  async 'readRange passes through where the backend has it, and is ENOTSUP where not'() {
    const noRange = { ...device({ '/a': '0123456789' }) };
    delete noRange.readRange;
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', () => device({ '/a': '0123456789' }));
    vfs.mount('/plain', () => noRange);
    assert.equal(dec.decode(await vfs.readRange('/pc/a', 3, 4)), '3456');
    assert.equal(await code(vfs.readRange('/plain/a', 0, 1)), 'ENOTSUP');
    assert.equal(await code(vfs.writeFileIfRevision('/plain/a', bytes('x'), 1)), 'ENOTSUP');
    assert.equal(await readText(vfs, '/plain/a'), '0123456789');
  },

  async 'per-principal namespaces: one table, each agent sees its own /pc'() {
    const machines = new Map([[5001, device({ '/who': 'agent A machine' })]]);
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/pc', ({ cred }) => (cred ? machines.get(cred.uid) ?? null : null), { absentReason: () => 'no device connected' });
    const a = vfs.as({ uid: 5001, gid: 5001, groups: [5001], umask: 0o022 });
    const b = vfs.as({ uid: 5002, gid: 5002, groups: [5002], umask: 0o022 });
    assert.equal(await readText(a, '/pc/who'), 'agent A machine');
    assert.ok((await names(a, '/')).includes('pc'));
    assert.equal(await code(b.readFile('/pc/who')), 'ENXIO');
    assert.ok(!(await names(b, '/')).includes('pc'));
    assert.equal(vfs.as({ uid: 5001, gid: 5001, groups: [5001], umask: 0o022 }), a, 'one view per principal while it is held');
    // Two actors with one credential, different /context each (Kinu node-runtime.ts:71).
    const contexts = new Map([['origin', device({ '/who': 'origin context' })], ['node-7', device({ '/who': 'node-7 context' })]]);
    vfs.mount('/context', ({ actor }) => contexts.get(actor ?? '') ?? null);
    const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
    assert.equal(await readText(vfs.as(cred, 'origin'), '/context/who'), 'origin context');
    assert.equal(await readText(vfs.as(cred, 'node-7'), '/context/who'), 'node-7 context');
    assert.equal(await code(vfs.as(cred).readFile('/context/who')), 'ENXIO');
    // Mounting on the shared table reaches every view.
    a.mount('/sandbox', sandbox({ '/w/x': 'shared' }));
    assert.equal(await readText(b, '/sandbox/w/x'), 'shared');
  },

  async "a credentialed backend is seen as the view's principal"() {
    const seen = [];
    const backend = {
      ...device({ '/f': 'x' }),
      as(cred) { seen.push(cred.uid); return { ...device({ '/f': `as ${cred.uid}` }) }; },
    };
    const vfs = new CompositeVFS(backend);
    const a = vfs.as({ uid: 7, gid: 7, groups: [7], umask: 0o022 });
    assert.equal(await readText(a, '/f'), 'as 7');
    assert.equal(await readText(a, '/f'), 'as 7');
    assert.deepEqual(seen, [7], 'once per view');
    assert.equal(await readText(vfs, '/f'), 'x', 'the embedder view is the backend itself');
  },

  async 'nested mounts, and directories synthesized above a mount point'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    const mnt = new MemoryVFS();
    mnt.writeFile('/on-mnt.txt', bytes('mnt'));
    vfs.mount('/mnt', mnt);
    vfs.mount('/mnt/pc', () => device({ '/deep.txt': 'deep' }));
    vfs.mount('/srv/data/cache', new MemoryVFS());
    assert.equal(await readText(vfs, '/mnt/on-mnt.txt'), 'mnt');
    assert.equal(await readText(vfs, '/mnt/pc/deep.txt'), 'deep');
    assert.deepEqual(await names(vfs, '/mnt'), ['on-mnt.txt', 'pc']);
    // /srv and /srv/data exist only to hold /srv/data/cache.
    assert.equal((await vfs.stat('/srv')).type, 'directory');
    assert.deepEqual(await names(vfs, '/srv'), ['data']);
    assert.deepEqual(await names(vfs, '/srv/data'), ['cache']);
    assert.equal(await code(vfs.rmdir('/srv')), 'EBUSY');
    assert.equal(vfs.mountOf('/mnt/pc/deep.txt'), '/mnt/pc');
    assert.equal(vfs.mountOf('/mnt/x'), '/mnt');
    assert.equal(vfs.mountOf('/etc'), '/');
    vfs.unmount('/mnt/pc');
    assert.deepEqual(await names(vfs, '/mnt'), ['on-mnt.txt']);
  },

  async 'removeRecursive fallback removes directories with rmdir where the backend has it'() {
    const calls = [];
    const tree = new MemoryVFS();
    tree.mkdir('/d/e', { recursive: true }); tree.writeFile('/d/e/f', bytes('x'));
    const counted = {
      stat: (p, o) => tree.stat(p, o), readFile: (p) => tree.readFile(p), writeFile: (p, d) => tree.writeFile(p, d),
      readdir: (p) => tree.readdir(p), mkdir: (p, o) => tree.mkdir(p, o),
      unlink: (p) => { calls.push(`unlink ${p}`); return tree.unlink(p); },
      rmdir: (p) => { calls.push(`rmdir ${p}`); return tree.rmdir(p); },
    };
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/m', counted);
    await vfs.removeRecursive('/m/d');
    assert.deepEqual(calls, ['unlink /d/e/f', 'rmdir /d/e', 'rmdir /d']);
  },

  async 'root links: followed into mounts, covered by mount points, ELOOP when they cycle'() {
    const root = new MemoryVFS();
    root.symlink('/pc/home', '/h');                  // a root link into a mount
    root.mkdir('/lnk'); root.symlink('../pc', '/lnk/to-pc');
    root.symlink('/elsewhere', '/pc');               // covered by the /pc mount point
    root.symlink('/loop-b', '/loop-a'); root.symlink('/loop-a', '/loop-b');
    const vfs = new CompositeVFS(root);
    vfs.mount('/pc', () => device({ '/home/notes.txt': 'through a link' }));
    assert.equal(await readText(vfs, '/h/notes.txt'), 'through a link');
    assert.equal(await readText(vfs, '/lnk/to-pc/home/notes.txt'), 'through a link');
    assert.equal((await vfs.stat('/pc')).type, 'directory', 'the mount point, not the root link under it');
    assert.equal((await vfs.stat('/h', { follow: false })).type, 'symlink');
    assert.equal(await code(vfs.readFile('/loop-a')), 'ELOOP');
    // A root link at a directory that exists only above a mount point is
    // covered by it too: /srv holds the /srv/data mount, not the link.
    root.symlink('/elsewhere', '/srv');
    vfs.mount('/srv/data', () => device({ '/x.txt': 'under srv' }));
    assert.equal((await vfs.stat('/srv')).type, 'directory');
    assert.deepEqual(await names(vfs, '/srv'), ['data']);
    assert.equal(await readText(vfs, '/srv/data/x.txt'), 'under srv');
    await vfs.unlink('/h');                          // unlink does not follow the final link
    assert.equal(await readText(vfs, '/pc/home/notes.txt'), 'through a link');
  },

  async "a mount point stats as the mounted backend's root"() {
    const tmp = new MemoryVFS();
    tmp.chmod('/', 0o1777);
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/tmp', tmp);
    assert.equal(((await vfs.stat('/tmp')).mode & 0o7777).toString(8), '1777', 'what the backend says, sticky bit and all');
    await vfs.chmod('/tmp', 0o700);
    assert.equal(((await vfs.stat('/tmp')).mode & 0o7777).toString(8), '700', 'a chmod through the mount point is seen by stat');
    // A backend that cannot stat its own root still has a directory there.
    vfs.mount('/sandbox', () => sandbox({ '/w/x': 'x' }));
    assert.equal((await vfs.stat('/sandbox')).type, 'directory');
  },

  async 'a root link then .. resolves physically, as Linux does'() {
    const root = new MemoryVFS();
    root.mkdir('/home'); root.writeFile('/home/f', bytes('ROOT'));
    const pc = new MemoryVFS();
    pc.mkdir('/dir'); pc.writeFile('/f', bytes('PC'));
    root.symlink('/pc/dir', '/home/l');
    const vfs = new CompositeVFS(root);
    vfs.mount('/pc', pc);
    assert.equal(await readText(vfs, '/home/l/../f'), 'PC', '.. applies after the link: /pc/f, not /home/f');
    root.symlink('/loop', '/loop');
    assert.equal(await code(vfs.readdir('/loop/..')), 'ELOOP');
  },

  async 'links resolve in the namespace, from any mount (Linux): /proc/self/cwd and /dev/stdin'() {
    const root = new MemoryVFS();
    root.mkdir('/home/user/app', { recursive: true });
    root.writeFile('/home/user/app/x.txt', bytes('in the cwd'));
    const proc = new MemoryVFS();
    proc.mkdir('/7/fd', { recursive: true });
    proc.symlink('/home/user/app', '/7/cwd');
    proc.symlink('7', '/self');
    proc.writeFile('/7/fd/0', bytes('stdin bytes'));
    const dev = new MemoryVFS();
    dev.symlink('/proc/self/fd/0', '/stdin');
    dev.symlink('../proc/self/fd/0', '/stdin-rel');
    dev.symlink('/dev/loop2', '/loop1');
    dev.symlink('/dev/loop1', '/loop2');
    const vfs = new CompositeVFS(root);
    vfs.mount('/proc', proc);
    vfs.mount('/dev', dev);
    // An absolute target starts at the namespace's root, not the mount's.
    assert.equal(await readText(vfs, '/proc/self/cwd/x.txt'), 'in the cwd');
    assert.deepEqual(await names(vfs, '/proc/self/cwd'), ['x.txt']);
    assert.equal(await readText(vfs, '/dev/stdin'), 'stdin bytes');
    // A relative one from the link's directory: `..` at /dev's root is /.
    assert.equal(await readText(vfs, '/dev/stdin-rel'), 'stdin bytes');
    assert.equal(dec.decode(vfs.sync.readFile('/dev/stdin')), 'stdin bytes', 'and synchronously');
    // stat follows; lstat names the link.
    assert.equal((await vfs.stat('/dev/stdin')).type, 'file');
    assert.equal((await vfs.stat('/dev/stdin', { follow: false })).type, 'symlink');
    // A write through the link lands where it points.
    await vfs.writeFile('/proc/self/cwd/y.txt', bytes('written'));
    assert.equal(dec.decode(root.readFile('/home/user/app/y.txt')), 'written');
    // A cycle is ELOOP.
    let error;
    try { await vfs.readFile('/dev/loop1'); } catch (e) { error = e; }
    assert.ok(isVfsError(error, 'ELOOP'), String(error));
  },

  async 'every hop is walked with the caller\'s credential'() {
    const root = new MemoryVFS();
    root.mkdir('/private', { recursive: true });
    root.writeFile('/private/secret', bytes('s'));
    root.chmod('/private', 0o700);
    const dev = new MemoryVFS();
    dev.symlink('/private/secret', '/leak');
    const vfs = new CompositeVFS(root);
    vfs.mount('/dev', dev);
    const stranger = vfs.as({ uid: 2, gid: 2, groups: [2], umask: 0o022 });
    let error;
    try { await stranger.readFile('/dev/leak'); } catch (e) { error = e; }
    assert.ok(isVfsError(error, 'EACCES'), `a link does not skip the search check: ${error}`);
    assert.equal(await readText(vfs.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }), '/dev/leak'), 's', 'the owner passes');
  },

  async 'views no one holds are not retained'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    const probe = new WeakRef(vfs.as({ uid: 1, gid: 1, groups: [1], umask: 0o022 }, 'agent-0'));
    for (let i = 1; i < 1000; i++) vfs.as({ uid: 1, gid: 1, groups: [1], umask: 0o022 }, `agent-${i}`);
    for (let i = 0; i < 20 && probe.deref() !== undefined; i++) { Bun.gc(true); await new Promise((r) => setTimeout(r, 0)); }
    assert.equal(probe.deref(), undefined, 'an unheld view is collected');
  },

  async 'the sync view: synchronous backends answer, an async-only mount refuses by name'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/tmp', new MemoryVFS());
    vfs.mount('/pc', () => device({ '/a': 'x' }));
    vfs.sync.writeFile('/tmp/a', bytes('sync'));
    assert.equal(dec.decode(vfs.sync.readFile('/tmp/a')), 'sync');
    assert.deepEqual(vfs.sync.readdir('/').map((e) => e.name).sort(), ['pc', 'tmp']);
    let error;
    try { vfs.sync.readFile('/pc/a'); } catch (e) { error = e; }
    assert.ok(isVfsError(error, 'EAGAIN'));
    assert.match(error.message, /\/pc is an asynchronous mount/);
    assert.equal(codeSync(() => vfs.sync.rename('/tmp/a', '/b')), 'EXDEV');
  },

  async 'mounts(): the live table for this principal, with each backend describing itself'() {
    const vfs = new CompositeVFS(new MemoryVFS());
    vfs.mount('/tmp', new MemoryVFS());
    vfs.mount('/pc', () => null);
    vfs.mount('/ro', new MemoryVFS(), { readOnly: true });
    assert.deepEqual(vfs.mounts().map((m) => m.point), ['/', '/tmp', '/ro']);
    assert.deepEqual(vfs.mounts()[1].describe(), { source: 'memory', type: 'tmpfs', options: ['rw'] });
    assert.equal(await code(vfs.writeFile('/ro/x', 'x')), 'EROFS');
    assert.equal(codeSync(() => vfs.mount('/tmp', new MemoryVFS())), 'EBUSY');
  },
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  try { await run(); console.log(`  ok  ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n${e?.stack ?? e}`); }
}
if (failed > 0) { console.log(`composite-vfs: ${failed} failed`); process.exit(1); }
console.log(`composite-vfs: ${Object.keys(cases).length} scenarios ok`);
