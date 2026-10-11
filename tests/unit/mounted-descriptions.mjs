#!/usr/bin/env bun
// A file on a mount is opened by one rule, and its description is one
// implementation, whichever face of a process opens it: the synchronous one
// (a mount that answers at once) or the one that awaits (an asynchronous
// mount). Linux's answers where Linux and POSIX differ; each case below was
// answered differently by one face or the other before.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { VfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const dec = new TextDecoder();
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const files = ws.filesystem;
ws.vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
ws.vfs.as(CRED_KERNEL).chown('home/user', 1000, 1000);

/** Every case runs, and every one that fails is reported: a red run names them all. */
const failed = [];
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')}`);
  }
};
const refused = (code) => ({ code });

/** Each backend method the asynchronous mount was asked, in order. */
const calls = [];
const backends = {
  sync: new MemoryVFS({ uid: 1000, gid: 1000 }),
  async: new MemoryVFS({ uid: 1000, gid: 1000 }),
};
files.vfs.mount('/s', backends.sync);
files.vfs.mount('/a', asyncOnly(backends.async, { deep: true, beforeCall: (method) => { calls.push(method); } }));

let pid = 7000;
for (const [face, at] of [['sync', '/s'], ['async', '/a']]) {
  const backend = backends[face];
  const proc = files.bind({ pid: ++pid, cred: USER });
  const seed = (name, text, mode = 0o644) => {
    backend.writeFile(`/${name}`, enc.encode(text));
    backend.chmod(`/${name}`, mode);
  };
  seed('plain', 'abc');
  backend.symlink('/plain', '/link');
  backend.symlink('/nowhere', '/dangling');
  backend.mkdir('/dir');

  await check(`${face}: an open asking no access is O_RDONLY`, async () => {
    const fd = await proc.open(`${at}/plain`, {});
    assert.equal(dec.decode(await proc.read(fd.id, 0, 3)), 'abc');
    await proc.close(fd.id);
  });

  await check(`${face}: O_NOFOLLOW of a link is ELOOP`, async () => {
    await assert.rejects(async () => proc.open(`${at}/link`, { followSymlinks: false }), refused('ELOOP'));
  });

  await check(`${face}: O_CREAT|O_EXCL of a link, even dangling, is EEXIST before ELOOP`, async () => {
    await assert.rejects(async () => proc.open(`${at}/dangling`, { write: true, create: true, exclusive: true, followSymlinks: false }), refused('EEXIST'));
    assert.equal(backend.stat('/nowhere'), null);
  });

  await check(`${face}: O_DIRECTORY of a file is ENOTDIR`, async () => {
    await assert.rejects(async () => proc.open(`${at}/plain`, { directory: true }), refused('ENOTDIR'));
  });

  await check(`${face}: O_CREAT|O_DIRECTORY of an absent name is EINVAL, nothing made`, async () => {
    await assert.rejects(async () => proc.open(`${at}/made`, { write: true, create: true, directory: true }), refused('EINVAL'));
    assert.equal(backend.stat('/made'), null);
  });

  await check(`${face}: a directory opens with write rights (a capability set)`, async () => {
    const fd = await proc.open(`${at}/dir`, { write: true });
    assert.deepEqual(await proc.readdirHandle(fd.id), []);
    await proc.close(fd.id);
  });

  await check(`${face}: O_TRUNC of a directory is EISDIR`, async () => {
    await assert.rejects(async () => proc.open(`${at}/dir`, { write: true, truncate: true }), refused('EISDIR'));
  });

  await check(`${face}: a mount of one identity has no modes to refuse by, and creat(2) writes what it makes`, async () => {
    seed('readonly', 'kept', 0o444);
    await proc.close((await proc.open(`${at}/readonly`, { write: true, append: true })).id);
    const fd = await proc.open(`${at}/readonly-new`, { write: true, create: true, exclusive: true, mode: 0o444 });
    await proc.write(fd.id, null, enc.encode('made'));
    await proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/readonly-new')), 'made');
  });

  await check(`${face}: O_TRUNC of a file is the mount's truncate`, async () => {
    seed('long', 'a long file');
    calls.length = 0;
    await proc.close((await proc.open(`${at}/long`, { write: true, truncate: true })).id);
    assert.equal(backend.readFile('/long').byteLength, 0);
    if (face === 'async') assert.ok(calls.includes('truncate') && !calls.includes('writeFile'), `asked: ${calls}`);
  });

  await check(`${face}: an O_APPEND descriptor starts at 0, and each append leaves it at the end`, async () => {
    seed('log', '12345');
    const fd = await proc.open(`${at}/log`, { write: true, append: true });
    assert.equal(await proc.seek(fd.id, 0, 'current'), 0);
    await proc.write(fd.id, null, enc.encode('67'));
    assert.equal(await proc.seek(fd.id, 0, 'current'), 7);
    await proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/log')), '1234567');
  });

  const reading = await proc.open(`${at}/plain`, { read: true });
  await check(`${face}: a mounted fstat carries the mount's revision, not the SQLite clock`, async () => {
    assert.equal((await proc.fstat(reading.id)).revision, (await proc.stat(`${at}/plain`)).revision);
  });
  await check(`${face}: a negative offset reads from 0`, async () => {
    assert.equal(dec.decode(await proc.read(reading.id, -5, 2)), 'ab');
  });
  await check(`${face}: a seek to no integer, or by an unknown whence, is EINVAL`, async () => {
    await assert.rejects(async () => proc.seek(reading.id, 0.5, 'set'), refused('EINVAL'));
    await assert.rejects(async () => proc.seek(reading.id, 0, 'nowhere'), refused('EINVAL'));
  });
  await check(`${face}: ftruncate of a read-only descriptor is EINVAL, and changes nothing`, async () => {
    await assert.rejects(async () => proc.ftruncate(reading.id, 0), refused('EINVAL'));
    assert.equal(dec.decode(backend.readFile('/plain')), 'abc');
  });
  await proc.close(reading.id);

  await check(`${face}: one numbering, and a dup outlives the descriptor it was made from`, async () => {
    const fd = await proc.open(`${at}/plain`, { read: true });
    const dup = await proc.dup(fd.id);
    await proc.close(fd.id);
    if (face === 'async') {
      // The synchronous face knows it, and refuses it as it refuses its mount.
      assert.throws(() => proc.synchronous.read(dup.id, 0, 1), (error) => error.code === 'EAGAIN' && error.asyncMount === true);
    } else {
      assert.equal(dec.decode(proc.synchronous.read(dup.id, 0, 1)), 'a');
    }
    assert.equal(dec.decode(await proc.read(dup.id, 1, 2)), 'bc');
    await proc.close(dup.id);
    await assert.rejects(async () => proc.read(dup.id, 0, 1), refused('EBADF'));
  });
}

await check('a mount whose writeRange refuses (ENOTSUP) holds the writes, read back by their process, written at the close', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  const refusing = new Proxy(backend, {
    get(target, key) {
      if (key === 'writeRange') return () => { throw new VfsError('ENOTSUP', 'no ranges here', '/x'); };
      if (key === 'sync') return refusing;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  files.vfs.mount('/r', refusing);
  backend.writeFile('/x', enc.encode('0123456789'));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/r/x', { read: true, write: true });
  assert.equal(proc.write(fd.id, 2, enc.encode('ab')), 2);
  assert.equal(dec.decode(proc.read(fd.id, 0, 10)), '01ab456789');
  assert.equal(dec.decode(backend.readFile('/x')), '0123456789');
  proc.close(fd.id);
  assert.equal(dec.decode(backend.readFile('/x')), '01ab456789');
});

// Who may open a mounted file for what is its backend's own policy (VFS.access), asked
// before anything changes: a backend that takes a caller's credential refuses by its modes.
await check('a credentialed mount refuses an open its modes deny, before the read', async () => {
  const other = createSqliteVfsTestHarness();
  const backend = sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL);
  backend.writeFile('/secret', enc.encode('no'));
  backend.chown('/secret', 2000, 2000);
  backend.chmod('/secret', 0o000);
  files.vfs.mount('/q', backend);
  const proc = files.bind({ pid: ++pid, cred: USER });
  await assert.rejects(async () => proc.open('/q/secret', { read: true }), refused('EACCES'));
  await assert.rejects(async () => proc.open('/proc/cpuinfo', { write: true }), refused('EACCES'));
  files.vfs.unmount('/q');
});

// An O_SYNC description's own writes are flushed as made; it reads the
// process's other descriptions' held writes all the same.
await check('an O_SYNC descriptor reads what another descriptor holds', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  const unranged = new Proxy(backend, {
    get(target, key) {
      if (key === 'writeRange') return undefined;
      if (key === 'sync') return unranged;
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (target, key) => key !== 'writeRange' && key in target,
  });
  files.vfs.mount('/h', unranged);
  backend.writeFile('/x', enc.encode('0123456789'));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const writer = proc.open('/h/x', { read: true, write: true });
  proc.write(writer.id, 0, enc.encode('ab'));
  const reader = proc.open('/h/x', { read: true, sync: true });
  assert.equal(dec.decode(proc.read(reader.id, 0, 10)), 'ab23456789');
  proc.close(reader.id);
  proc.close(writer.id);
  files.vfs.unmount('/h');
});

// A description holds the file its open found: a mount made at its name
// later, after the first was unmounted, is not where its I/O goes, nor
// where its held writes are flushed.
await check('a description holds its file across an unmount and a mount at its name', async () => {
  for (const [face, wrap] of [['sync', (vfs) => vfs], ['async', (vfs) => asyncOnly(vfs, { deep: true })]]) {
    const first = new MemoryVFS({ uid: 1000, gid: 1000 });
    const second = new MemoryVFS({ uid: 1000, gid: 1000 });
    first.writeFile('/x', enc.encode('first'));
    second.writeFile('/x', enc.encode('second'));
    files.vfs.mount('/p', wrap(first));
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = await proc.open('/p/x', { read: true, write: true });
    files.vfs.unmount('/p');
    files.vfs.mount('/p', wrap(second));
    assert.equal(dec.decode(await proc.read(fd.id, 0, 5)), 'first', `${face}: it reads the file it opened`);
    await proc.write(fd.id, 0, enc.encode('FIRST'));
    await proc.close(fd.id);
    assert.equal(dec.decode(first.readFile('/x')), 'FIRST', `${face}: and writes it`);
    assert.equal(dec.decode(second.readFile('/x')), 'second', `${face}: never the one mounted since`);
    files.vfs.unmount('/p');
  }
});

// ── The open resolves once: everything it and its description do is the file it found ──
const text = (ref) => (ref === null || ref === undefined ? ref : dec.decode(ref.read()));
const unranged = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'writeRange') return undefined;
    if (key === 'sync') return unranged(target);
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
  has: (target, key) => key !== 'writeRange' && key in target,
});

await check('a mount made at the name while the open awaits its access check is not what it truncates', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  let release;
  const asked = new Promise((resolve) => { release = resolve; });
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/w', asyncOnly(first, { deep: true, methods: { access() {} }, beforeCall: (method) => (method === 'access' ? (entered(), asked) : undefined) }));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const opening = proc.open('/w/x', { read: true, write: true, truncate: true });
  await entering;
  files.vfs.unmount('/w');
  files.vfs.mount('/w', asyncOnly(second, { deep: true }));
  release();
  const fd = await opening;
  assert.equal(first.readFile('/x').byteLength, 0, 'the file it found is truncated');
  assert.equal(dec.decode(second.readFile('/x')), 'second', 'the one mounted since is untouched');
  assert.equal((await proc.read(fd.id, 0, 10)).byteLength, 0, 'and its descriptor reads the file it truncated');
  await proc.close(fd.id);
  files.vfs.unmount('/w');
});

await check('held writes overlay the file they are for, not one that has its name since', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  files.vfs.mount('/v', unranged(first));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/v/x', { read: true, write: true });
  proc.write(fd.id, 0, enc.encode('FI'));
  files.vfs.unmount('/v');
  files.vfs.mount('/v', unranged(second));
  assert.equal(dec.decode(proc.readFile('/v/x')), 'second', 'a path read of the new mount');
  const other = proc.open('/v/x', { read: true });
  assert.equal(dec.decode(proc.read(other.id, 0, 10)), 'second', 'a descriptor on the new mount');
  assert.equal(dec.decode(proc.read(fd.id, 0, 10)), 'FIrst', 'the old descriptor still sees its own');
  proc.close(other.id);
  proc.close(fd.id);
  assert.equal(dec.decode(first.readFile('/x')), 'FIrst');
  assert.equal(dec.decode(second.readFile('/x')), 'second');
  files.vfs.unmount('/v');
});

await check('fstat of a mounted file has the identity its stat has', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('x'));
  files.vfs.mount('/i', backend);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/i/x', { read: true });
  const [st, fst] = [proc.stat('/i/x'), proc.fstat(fd.id)];
  assert.deepEqual([fst.dev, fst.ino], [st.dev, st.ino]);
  assert.ok(st.ino !== 0 && st.dev !== 0);
  proc.close(fd.id);
  files.vfs.unmount('/i');
});

await check('a write through a descriptor is heard as the file the mount resolved, not its link text', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/real', enc.encode('real'));
  backend.symlink('/real', '/alias');
  files.vfs.mount('/r2', backend, { resolvesPaths: true });
  const heard = [];
  const stop = files.vfs.observeWrites((event) => { if (event.path.startsWith('/r2')) heard.push([event.path, text(event.before), text(event.after)]); });
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/r2/alias', { read: true, write: true });
    proc.write(fd.id, 0, enc.encode('RE'));
    proc.close(fd.id);
    assert.deepEqual(heard, [['/r2/alias', 'real', 'REal']]);
  } finally {
    stop();
    files.vfs.unmount('/r2');
  }
});

await check('a write to a file whose mount left its point is not heard as a change to what is there now', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  files.vfs.mount('/u', first);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/u/x', { read: true, write: true });
  files.vfs.unmount('/u');
  files.vfs.mount('/u', second);
  const heard = [];
  const stop = files.vfs.observeWrites((event) => { if (event.path.startsWith('/u')) heard.push(event.path); });
  try {
    proc.write(fd.id, 0, enc.encode('FI'));
    proc.close(fd.id);
    assert.deepEqual(heard, []);
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst');
  } finally {
    stop();
    files.vfs.unmount('/u');
  }
});

await check('a pin cannot reach what the namespace hides under a directory it makes', async () => {
  const kernel = ws.vfs.as(CRED_KERNEL);
  kernel.mkdir('real', { recursive: true });
  kernel.writeFile('real/hidden', 'covered');
  kernel.symlink('/real', 'parent');
  files.vfs.mount('/parent/mounted', new MemoryVFS({ uid: 1000, gid: 1000 }));
  const view = files.vfs.as(USER);
  assert.equal(await view.stat('/parent/hidden'), null, 'the namespace shows nothing there');
  assert.throws(() => view.pin('/parent/hidden', { follow: true, sync: true }), refused('ENOENT'));
  files.vfs.unmount('/parent/mounted');
});

await check('a mount point opened is its mount\'s root, after an unmount and a mount there too', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/in-first', enc.encode('1'));
  second.writeFile('/in-second', enc.encode('2'));
  files.vfs.mount('/d', first);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/d', { read: true, directory: true });
  files.vfs.unmount('/d');
  files.vfs.mount('/d', second);
  assert.deepEqual(proc.readdirHandle(fd.id).map((entry) => entry.name), ['in-first']);
  proc.close(fd.id);
  files.vfs.unmount('/d');
});

// ── The class, closed: an O_EXCL open answers for the name; a write in flight; reads that only await ──
await check('O_CREAT|O_EXCL of a dangling link, following links, is EEXIST on every filesystem and makes nothing', async () => {
  const kernel = ws.vfs.as(CRED_KERNEL);
  kernel.symlink('/home/user/sq-target', 'home/user/sq-link');
  for (const [face, wrap] of [['sync', (vfs) => vfs], ['async', (vfs) => asyncOnly(vfs, { deep: true })]]) {
    const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
    backend.symlink('/target', '/link');
    files.vfs.mount('/x1', wrap(backend));
    const proc = files.bind({ pid: ++pid, cred: USER });
    await assert.rejects(async () => proc.open('/x1/link', { write: true, create: true, exclusive: true }), refused('EEXIST'), face);
    assert.equal(backend.stat('/target'), null, `${face}: nothing made`);
    files.vfs.unmount('/x1');
  }
  const proc = files.bind({ pid: ++pid, cred: USER });
  await assert.rejects(async () => proc.open('/home/user/sq-link', { write: true, create: true, exclusive: true }), refused('EEXIST'), 'sqlite');
  await assert.rejects(async () => proc.open('/home/user/sq-link', { write: true, create: true, exclusive: true, followSymlinks: false }), refused('EEXIST'), 'sqlite: EEXIST before ELOOP');
  assert.equal(kernel.exists('home/user/sq-target'), false, 'sqlite: nothing made');
});

await check('a write in flight when its mount leaves its point is not heard as a change to what is there now', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/f1', asyncOnly(first, { deep: true, beforeCall: (method) => (method === 'writeRange' ? (entered(), held) : undefined) }));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = await proc.open('/f1/x', { read: true, write: true });
  const heard = [];
  const stop = files.vfs.observeWrites((event) => { if (event.path.startsWith('/f1')) heard.push(event.path); });
  try {
    const writing = proc.write(fd.id, 0, enc.encode('FI'));
    await entering;
    files.vfs.unmount('/f1');
    files.vfs.mount('/f1', second);
    release();
    await writing;
    await proc.close(fd.id);
    assert.deepEqual(heard, []);
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst');
  } finally {
    stop();
    files.vfs.unmount('/f1');
  }
});

await check('held writes are read back through an asynchronous mount above their file, by path and by a descriptor', async () => {
  const inner = new MemoryVFS({ uid: 1000, gid: 1000 });
  inner.writeFile('/x', enc.encode('0123456789'));
  files.vfs.mount('/outer/inner', unranged(inner));
  const proc = files.bind({ pid: ++pid, cred: USER });
  const writer = proc.open('/outer/inner/x', { read: true, write: true });
  proc.write(writer.id, 0, enc.encode('ab'));
  files.vfs.mount('/outer', asyncOnly(new MemoryVFS({ uid: 1000, gid: 1000 }), { deep: true }));
  try {
    assert.equal(dec.decode(await proc.readFile('/outer/inner/x')), 'ab23456789', 'a path read');
    assert.equal((await proc.stat('/outer/inner/x')).size, 10);
    const reader = await proc.open('/outer/inner/x', { read: true });
    assert.equal(dec.decode(await proc.read(reader.id, 0, 10)), 'ab23456789', 'a descriptor opened by awaiting');
    // Found by awaiting, on a mount that answers at once: the synchronous face serves it.
    assert.equal(dec.decode(proc.synchronous.read(reader.id, 0, 2)), 'ab');
    await proc.close(reader.id);
  } finally {
    proc.close(writer.id);
    files.vfs.unmount('/outer');
    files.vfs.unmount('/outer/inner');
  }
  assert.equal(dec.decode(inner.readFile('/x')), 'ab23456789');
});

{
  const proc = files.bind({ pid: ++pid, cred: USER });
  proc.writeFile('/home/user/sq.log', '12345');
  await check('sqlite: an O_APPEND descriptor starts at 0, and each append leaves it at the end', () => {
    const fd = proc.open('/home/user/sq.log', { write: true, append: true });
    try {
      assert.equal(proc.seek(fd.id, 0, 'current'), 0);
      proc.write(fd.id, null, enc.encode('67'));
      assert.equal(proc.seek(fd.id, 0, 'current'), 7);
    } finally {
      proc.close(fd.id);
    }
  });
  await check('sqlite: ftruncate of a read-only descriptor is EINVAL', () => {
    const fd = proc.open('/home/user/sq.log', { read: true });
    try {
      assert.throws(() => proc.ftruncate(fd.id, 0), refused('EINVAL'));
    } finally {
      proc.close(fd.id);
    }
  });
}

assert.deepEqual(failed, []);
console.log('mounted-descriptions: ok');
