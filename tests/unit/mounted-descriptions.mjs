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
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

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
  await check(`${face}: a negative offset is EINVAL, as pread(2) answers it`, async () => {
    await assert.rejects(async () => proc.read(reading.id, -5, 2), refused('EINVAL'));
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

/** `vfs` that writes no range (a mount that cannot write in place): a description holds its writes. */
const unranged = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'writeRange') return undefined;
    if (key === 'sync') return unranged(target);
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
  has: (target, key) => key !== 'writeRange' && key in target,
});

/** A SqliteFiles backend of its own (a credentialed mount), `/x` seeded with `text`, owned by the user. */
const credentialed = (text = 'x') => {
  const other = createSqliteVfsTestHarness();
  const backend = sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL);
  backend.writeFile('/x', enc.encode(text));
  backend.chown('/x', 1000, 1000);
  return backend;
};

// An O_SYNC description's own writes are flushed as made; it reads the
// process's other descriptions' held writes all the same.
await check('an O_SYNC descriptor reads what another descriptor holds', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  files.vfs.mount('/h', unranged(backend));
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

// ── A wave's open of a file on a mount keeps it as the process's description ──
await check('a wave\'s description of a mounted file holds it: its writes, appends and truncates go there after a remount', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  files.vfs.mount('/g', first);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const wave = async (ops) => {
    const result = await proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result;
  };
  try {
    const opened = await wave([{ type: 'call', call: { call: 'open', path: 'g/x', mode: 0o644, read: true, description: 'd1' } }]);
    assert.equal(opened.receipts.length, 1, 'the open answers its file');
    files.vfs.unmount('/g');
    files.vfs.mount('/g', second);
    await wave([
      { type: 'call', call: { call: 'write', path: 'g/x', description: 'd1', offset: 0, data: enc.encode('FI') } },
      { type: 'call', call: { call: 'append', path: 'g/x', description: 'd1', data: enc.encode('!') } },
    ]);
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst!', 'the file it opened');
    await wave([{ type: 'call', call: { call: 'ftruncate', path: 'g/x', description: 'd1', size: 2 } }]);
    assert.equal(dec.decode(first.readFile('/x')), 'FI');
    assert.equal(dec.decode(second.readFile('/x')), 'second', 'never the one mounted since');
    await wave([{ type: 'call', call: { call: 'close', path: 'g/x', description: 'd1' } }]);
  } finally {
    files.vfs.unmount('/g');
  }
});

// ── A wave's open keeps the access it asked, on a mount as on SQLite ──
await check('a wave\'s read-only description of a mounted file refuses a write through it (EBADF)', async () => {
  const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
  mounted.writeFile('/x', enc.encode('kept'));
  files.vfs.mount('/ro', mounted);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const wave = (ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
  try {
    const opened = await wave([{ type: 'call', call: { call: 'open', path: 'ro/x', mode: 0o644, access: 'read', description: 'r1' } }]);
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    const written = await wave([{ type: 'call', call: { call: 'write', path: 'ro/x', description: 'r1', offset: 0, data: enc.encode('XX') } }]);
    assert.equal(written.ok, false, 'a write through a read-only description is refused');
    assert.equal(written.error?.errno ?? written.sequence?.refused?.errno, 'EBADF');
    assert.equal(dec.decode(mounted.readFile('/x')), 'kept');
    await wave([{ type: 'call', call: { call: 'close', path: 'ro/x', description: 'r1' } }]);
  } finally {
    files.vfs.unmount('/ro');
  }
});

// ── open(2)'s rule, in Linux's order, on every filesystem: a mount's (either face), SQLite's ──
const kernel = ws.vfs.as(CRED_KERNEL);
kernel.writeFile('home/user/rule.txt', 'rule');
kernel.symlink('/home/user', 'home/user/dir-link');
backends.sync.symlink('/dir', '/dir-link');
backends.async.symlink('/dir', '/dir-link');

await check('O_CREAT|O_DIRECTORY is EINVAL before any name is looked up, on every filesystem', async () => {
  const proc = files.bind({ pid: ++pid, cred: USER });
  for (const name of ['/s/dir', '/s/plain', '/s/absent/below', '/a/dir', '/a/plain', '/a/absent/below', '/home/user', '/home/user/rule.txt', '/home/user/absent/below', '/']) {
    await assert.rejects(async () => proc.open(name, { read: true, create: true, directory: true }), refused('EINVAL'), name);
    await assert.rejects(async () => proc.open(name, { read: true, create: true, exclusive: true, directory: true }), refused('EINVAL'), `${name}, O_EXCL`);
  }
});

await check('O_CREAT of a directory is EISDIR (O_EXCL: EEXIST), on every filesystem', async () => {
  const proc = files.bind({ pid: ++pid, cred: USER });
  for (const dir of ['/s/dir', '/a/dir', '/home/user', '/']) {
    await assert.rejects(async () => proc.open(dir, { read: true, create: true }), refused('EISDIR'), dir);
    await assert.rejects(async () => proc.open(dir, { read: true, create: true, exclusive: true }), refused('EEXIST'), `${dir}, O_EXCL`);
  }
});

await check('O_DIRECTORY|O_NOFOLLOW of a link is ENOTDIR, plain O_NOFOLLOW ELOOP, on every filesystem', async () => {
  const proc = files.bind({ pid: ++pid, cred: USER });
  for (const link of ['/s/dir-link', '/s/link', '/s/dangling', '/a/dir-link', '/a/dangling', '/home/user/dir-link']) {
    await assert.rejects(async () => proc.open(link, { read: true, directory: true, followSymlinks: false }), refused('ENOTDIR'), link);
    await assert.rejects(async () => proc.open(link, { read: true, followSymlinks: false }), refused('ELOOP'), `${link}, O_NOFOLLOW alone`);
  }
});

await check('O_TRUNC asks to write, whatever access the descriptor has, on every filesystem', async () => {
  const proc = files.bind({ pid: ++pid, cred: USER });
  await assert.rejects(async () => proc.open('/proc/cpuinfo', { read: true, truncate: true }), refused('EACCES'), '/proc');
  const other = createSqliteVfsTestHarness();
  const backend = sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL);
  backend.writeFile('/kept', enc.encode('kept'));
  backend.chmod('/kept', 0o444);
  files.vfs.mount('/q2', backend);
  try {
    await assert.rejects(async () => proc.open('/q2/kept', { read: true, truncate: true }), refused('EACCES'), 'a credentialed mount');
    assert.equal(dec.decode(backend.readFile('/kept')), 'kept');
  } finally {
    files.vfs.unmount('/q2');
  }
  kernel.writeFile('home/user/kept.txt', 'kept');
  kernel.chmod('home/user/kept.txt', 0o444);
  await assert.rejects(async () => proc.open('/home/user/kept.txt', { read: true, truncate: true }), refused('EACCES'), 'sqlite');
  assert.equal(dec.decode(kernel.readFile('home/user/kept.txt')), 'kept');
});

// ── A description's held writes, and every later change of their file ──
/** `vfs` that writes no range in place (ENOTSUP), but truncates. */
const refusingRanges = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'writeRange') return () => { throw new VfsError('ENOTSUP', 'no ranges here', '/'); };
    if (key === 'sync') return refusingRanges(target);
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

await check('held writes are written before their process cuts their file, and nothing brings back what it cut', async () => {
  for (const [how, cut] of [
    ['an ftruncate through another descriptor', (proc) => { const other = proc.open('/t/x', { read: true, write: true }); proc.ftruncate(other.id, 0); proc.close(other.id); }],
    ['an ftruncate through the same descriptor', (proc, fd) => proc.ftruncate(fd.id, 0)],
    ['an O_TRUNC open', (proc) => proc.close(proc.open('/t/x', { write: true, truncate: true }).id)],
    ['a truncate by name', (proc) => proc.truncate('/t/x', 0)],
  ]) {
    const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
    backend.writeFile('/x', enc.encode('0123456789'));
    files.vfs.mount('/t', refusingRanges(backend));
    try {
      const proc = files.bind({ pid: ++pid, cred: USER });
      const fd = proc.open('/t/x', { read: true, write: true });
      proc.write(fd.id, 2, enc.encode('ab'));
      cut(proc, fd);
      assert.equal(proc.fstat(fd.id).size, 0, `${how}: the descriptor sees the cut`);
      assert.equal(proc.read(fd.id, 0, 4).byteLength, 0, `${how}: and reads it`);
      proc.close(fd.id);
      assert.equal(backend.readFile('/x').byteLength, 0, `${how}: its close brings nothing back`);
    } finally {
      files.vfs.unmount('/t');
    }
  }
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('abcdef'));
  files.vfs.mount('/t', unranged(backend));
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/t/x', { read: true, write: true });
    proc.write(fd.id, 4, enc.encode('XX'));
    proc.ftruncate(fd.id, 2);
    assert.equal(proc.fstat(fd.id).size, 2);
    proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/x')), 'ab', 'a held write past the cut is not written back');
  } finally {
    files.vfs.unmount('/t');
  }
});

await check('held writes overlay the file of the backend they were made on, not one a source gives since at its name', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  const [fromFirst, fromSecond] = [unranged(first), unranged(second)];
  let current = fromFirst;
  files.vfs.mount('/dyn', () => current);
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/dyn/x', { read: true, write: true });
    proc.write(fd.id, 0, enc.encode('FI'));
    current = fromSecond;
    assert.equal(dec.decode(proc.readFile('/dyn/x')), 'second', 'a path read');
    const other = proc.open('/dyn/x', { read: true });
    assert.equal(dec.decode(proc.read(other.id, 0, 10)), 'second', 'a descriptor opened since');
    proc.close(other.id);
    proc.close(fd.id);
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst');
    assert.equal(dec.decode(second.readFile('/x')), 'second');
  } finally {
    files.vfs.unmount('/dyn');
  }
});

await check('held writes apply in their descriptions\' open order, whatever dups of them are closed', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('----'));
  files.vfs.mount('/oo', unranged(backend));
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const a = proc.open('/oo/x', { read: true, write: true });
    const b = proc.open('/oo/x', { read: true, write: true });
    proc.write(a.id, 0, enc.encode('AA'));
    proc.write(b.id, 0, enc.encode('BB'));
    const dup = proc.dup(a.id);
    proc.close(a.id);
    assert.equal(dec.decode(proc.readFile('/oo/x')), 'BB--', 'the later open\'s write is over the earlier\'s');
    proc.ftruncate(b.id, 2);
    assert.equal(dec.decode(backend.readFile('/x')), 'BB', 'and they are written in that order before the cut');
    proc.close(dup.id);
    proc.close(b.id);
  } finally {
    files.vfs.unmount('/oo');
  }
});

await check('held writes overlay their own database\'s file, not another database\'s of the same number', async () => {
  /** `vfs` that writes no range and keeps no open file, in every view of it: a description holds its writes. */
  const holding = (vfs) => new Proxy(vfs, {
    get(target, key) {
      if (key === 'writeRange' || key === 'openFile') return undefined;
      if (key === 'sync') return holding(target);
      if (key === 'as') return (...args) => holding(target.as(...args));
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (target, key) => key !== 'writeRange' && key !== 'openFile' && key in target,
  });
  const [first, second] = [credentialed('first'), credentialed('second')];
  const [fromFirst, fromSecond] = [holding(first), holding(second)];
  assert.equal(first.stat('/x').ino, second.stat('/x').ino, 'the two files have one number, each in its own database');
  let current = fromFirst;
  files.vfs.mount('/db', () => current);
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/db/x', { read: true, write: true });
    proc.write(fd.id, 0, enc.encode('FI'));
    current = fromSecond;
    assert.equal(dec.decode(proc.readFile('/db/x')), 'second');
    proc.close(fd.id);
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst');
    assert.equal(dec.decode(second.readFile('/x')), 'second');
  } finally {
    files.vfs.unmount('/db');
  }
});

// ── A description holds its file, not its name ──
await check('a description of a file its mount keeps open is that file across a rename, and the new file at its name is another', async () => {
  const other = createSqliteVfsTestHarness();
  const backend = sqliteFiles(new SqliteVFS(other.sql, other.ctx), CRED_KERNEL);
  backend.writeFile('/x', enc.encode('old'));
  backend.chown('/x', 1000, 1000);
  files.vfs.mount('/o', backend);
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/o/x', { read: true, write: true });
    backend.rename('/x', '/y');
    backend.writeFile('/x', enc.encode('new'));
    proc.write(fd.id, 0, enc.encode('OLD'));
    assert.equal(dec.decode(proc.read(fd.id, 0, 3)), 'OLD');
    assert.equal(proc.fstat(fd.id).ino, proc.stat('/o/y').ino);
    proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/y')), 'OLD');
    assert.equal(dec.decode(backend.readFile('/x')), 'new');
  } finally {
    files.vfs.unmount('/o');
  }
});

await check('a description held by its name refuses (ESTALE) once the name holds another file or none, and writes neither', async () => {
  for (const [how, change] of [
    ['renamed, and another made at its name', (backend) => { backend.rename('/x', '/y'); backend.writeFile('/x', enc.encode('new')); }],
    ['unlinked', (backend) => backend.unlink('/x')],
  ]) {
    const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
    backend.writeFile('/x', enc.encode('old'));
    files.vfs.mount('/n', unranged(backend));
    try {
      const proc = files.bind({ pid: ++pid, cred: USER });
      const fd = proc.open('/n/x', { read: true, write: true });
      proc.write(fd.id, 0, enc.encode('OLD'));
      change(backend);
      if (backend.stat('/x') !== null) assert.equal(dec.decode(proc.readFile('/n/x')), 'new', `${how}: a path read is the file there now`);
      assert.throws(() => proc.close(fd.id), refused('ESTALE'), how);
      assert.equal(backend.stat('/x') === null ? null : dec.decode(backend.readFile('/x')), how === 'unlinked' ? null : 'new', `${how}: nothing written at the name`);
      if (backend.stat('/y') !== null) assert.equal(dec.decode(backend.readFile('/y')), 'old', `${how}: nor to the file renamed`);
    } finally {
      files.vfs.unmount('/n');
    }
  }
});

await check('a description held by its name on an awaiting mount asks for its file in its change\'s turn, after a rename before it', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('old'));
  let gate = null;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  // The write's first look at the name, while the rename is held: a check made there, before its turn, is stale by the time it writes.
  let watching = false;
  let looked;
  const looking = new Promise((resolve) => { looked = resolve; });
  files.vfs.mount('/nr', asyncOnly(backend, { deep: true, beforeCall: (method) => {
    if (gate !== null && method === 'rename') { entered(); return gate; }
    if (watching && method === 'stat') looked();
  } }));
  const stop = files.vfs.observeWrites(() => {});
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = await proc.open('/nr/x', { read: true, write: true });
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    const renaming = proc.rename('/nr/x', '/nr/y');
    await entering;
    watching = true;
    const writing = assert.rejects(async () => proc.write(fd.id, 0, enc.encode('NEW')), refused('ESTALE'));
    await Promise.race([looking, new Promise((resolve) => setTimeout(resolve, 50))]);
    release();
    await renaming;
    await writing;
    assert.equal(backend.stat('/x'), null, 'nothing is made at the name');
    assert.equal(dec.decode(backend.readFile('/y')), 'old');
    await proc.close(fd.id);
  } finally {
    gate = null;
    stop();
    files.vfs.unmount('/nr');
  }
});

await check('a write to a file a mount made since covers is not heard as a change to what is there now', async () => {
  const outer = new MemoryVFS({ uid: 1000, gid: 1000 });
  outer.mkdir('/sub');
  outer.writeFile('/sub/x', enc.encode('old'));
  const inner = new MemoryVFS({ uid: 1000, gid: 1000 });
  inner.writeFile('/x', enc.encode('new'));
  files.vfs.mount('/c', outer);
  const proc = files.bind({ pid: ++pid, cred: USER });
  const fd = proc.open('/c/sub/x', { read: true, write: true });
  files.vfs.mount('/c/sub', inner);
  const heard = [];
  const stop = files.vfs.observeWrites((event) => { if (event.path.startsWith('/c')) heard.push(event.path); });
  try {
    proc.write(fd.id, 0, enc.encode('OLD'));
    assert.deepEqual(heard, []);
    assert.equal(dec.decode(outer.readFile('/sub/x')), 'OLD');
    assert.equal(dec.decode(proc.readFile('/c/sub/x')), 'new');
  } finally {
    stop();
    proc.close(fd.id);
    files.vfs.unmount('/c/sub');
    files.vfs.unmount('/c');
  }
});

// ── A wave's description: its calls are its own, its process's while that lives ──
const waveOf = (proc, options) => async (ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }), options);

await check('a wave\'s call through a description is that description\'s: its file with its mount gone, EBADF once closed', async () => {
  const first = new MemoryVFS({ uid: 1000, gid: 1000 });
  const second = new MemoryVFS({ uid: 1000, gid: 1000 });
  first.writeFile('/x', enc.encode('first'));
  second.writeFile('/x', enc.encode('second'));
  files.vfs.mount('/e', first);
  const wave = waveOf(files.bind({ pid: ++pid, cred: USER }));
  try {
    const opened = await wave([{ type: 'call', call: { call: 'open', path: 'e/x', mode: 0o644, read: true, description: 'd1' } }]);
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    files.vfs.unmount('/e');
    const live = await wave([{ type: 'call', call: { call: 'write', path: 'e/x', description: 'd1', offset: 0, data: enc.encode('FI') } }]);
    assert.equal(live.ok, true, JSON.stringify(live.error));
    assert.equal(dec.decode(first.readFile('/x')), 'FIrst', 'a live description writes its file, its mount gone');
    files.vfs.mount('/e', second);
    assert.equal((await wave([{ type: 'call', call: { call: 'close', path: 'e/x', description: 'd1' } }])).ok, true);
    for (const call of [
      { call: 'write', path: 'e/x', description: 'd1', offset: 0, data: enc.encode('NO') },
      { call: 'append', path: 'e/x', description: 'd1', data: enc.encode('NO') },
      { call: 'ftruncate', path: 'e/x', description: 'd1', size: 0 },
    ]) {
      const closed = await wave([{ type: 'call', call }]);
      assert.equal(closed.ok, false, call.call);
      assert.equal(closed.error.errno, 'EBADF', call.call);
    }
    assert.equal(dec.decode(second.readFile('/x')), 'second', 'never the file at its name');
  } finally {
    files.vfs.unmount('/e');
  }
});

await check('a wave\'s open of a mounted file answers its descriptor, and answers it again when re-sent', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('x'));
  files.vfs.mount('/rc', backend);
  const procPid = ++pid;
  const proc = files.bind({ pid: procPid, cred: USER });
  const send = waveOf(proc, { sequence: { writer: `${procPid}:w`, first: 1, ack: 0, pid: procPid } });
  const open = [{ type: 'call', call: { call: 'open', path: 'rc/x', mode: 0o644, read: true, description: 'd1' } }];
  try {
    const first = await send(open);
    assert.equal(first.ok, true, JSON.stringify(first.error));
    const handle = first.receipts[0]?.handle;
    assert.equal(typeof handle, 'number', 'the open answers its descriptor');
    assert.equal(dec.decode(proc.read(handle, 0, 1)), 'x');
    const again = await send(open);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.equal(again.receipts[0]?.handle, handle, 'and the same one when re-sent');
  } finally {
    files.vfs.unmount('/rc');
  }
});

await check('a wave\'s change through a description does not reach its mount once its process is released', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('kept'));
  let gate = null;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/k', asyncOnly(backend, { deep: true, beforeCall: (method) => (gate !== null && method === 'stat' ? (entered(), gate) : undefined) }));
  const procPid = ++pid;
  const wave = waveOf(files.bind({ pid: procPid, cred: USER }));
  // An observer: the before-image is read first, by awaiting.
  const stop = files.vfs.observeWrites(() => {});
  try {
    const opened = await wave([{ type: 'call', call: { call: 'open', path: 'k/x', mode: 0o644, read: true, description: 'd1' } }]);
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    const cutting = wave([{ type: 'call', call: { call: 'ftruncate', path: 'k/x', description: 'd1', size: 0 } }]);
    await entering;
    await files.releaseProcess(procPid).catch(() => {});
    release();
    assert.equal((await cutting).ok, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dec.decode(backend.readFile('/x')), 'kept');
  } finally {
    gate = null;
    stop();
    files.vfs.unmount('/k');
  }
});

// ── A file a backend keeps open: the one the open decided on, guarded where it is named now, closed whatever happens ──
/** `vfs` with its open files' operations replaced by `file`'s (each given the backend's own open file). */
const reopening = (vfs, file, sync = true) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return sync ? reopening(target, file, sync) : undefined;
    if (key === 'as') return () => reopening(target, file, sync);
    if (key === 'openFile') return (path, rights) => andThenSync(target.openFile(path, rights), (opened) => ({ ...opened, ...file(opened, path) }));
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
  has: (target, key) => (key === 'sync' ? sync : key in target),
});
const andThenSync = (value, then) => (value instanceof Promise ? value.then(then) : then(value));

await check('an open holds the file it decided on: one put at its name while the backend opened it is ESTALE, never read', async () => {
  const backend = credentialed('public');
  backend.chmod('/x', 0o644);
  backend.chown('/x', 0, 0);
  let gate = null;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/ho', asyncOnly(backend, { deep: true, beforeCall: (method) => (gate !== null && method === 'openFile' ? (entered(), gate) : undefined) }));
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    const opening = assert.rejects(async () => proc.open('/ho/x', { read: true }), refused('ESTALE'));
    await entering;
    backend.unlink('/x');
    backend.writeFile('/x', enc.encode('secret'));
    backend.chmod('/x', 0o000);
    release();
    await opening;
  } finally {
    gate = null;
    files.vfs.unmount('/ho');
  }
});

await check('a file its mount keeps open is guarded where it is named now: a lease on the directory it was renamed into refuses its writes', async () => {
  const backend = credentialed();
  for (const dir of ['/free', '/leased']) { backend.mkdir(dir); backend.chown(dir, 1000, 1000); }
  backend.rename('/x', '/free/x');
  files.vfs.mount('/lm', backend);
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/lm/free/x', { read: true, write: true });
    proc.rename('/lm/free/x', '/lm/leased/x');
    const lease = files.engine.acquireExclusiveMutation('lm/leased');
    try {
      assert.throws(() => proc.write(fd.id, 0, enc.encode('NO')), refused('EBUSY'));
      assert.throws(() => proc.ftruncate(fd.id, 0), refused('EBUSY'));
      assert.equal(dec.decode(backend.readFile('/leased/x')), 'x');
    } finally {
      files.engine.releaseExclusiveMutation(lease.owner);
    }
    proc.write(fd.id, 0, enc.encode('Y'));
    proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/leased/x')), 'Y');
  } finally {
    files.vfs.unmount('/lm');
  }
});

await check('a close, and a release, answer what the backend\'s close of its open file failed with', async () => {
  const failing = (opened, path) => ({ close: async () => { await opened.close(); throw new VfsError('EIO', 'the backend failed its close', path); } });
  files.vfs.mount('/cf', reopening(credentialed(), failing, false));
  try {
    const procPid = ++pid;
    const proc = files.bind({ pid: procPid, cred: USER });
    const fd = await proc.open('/cf/x', { read: true });
    await assert.rejects(async () => proc.close(fd.id), refused('EIO'));
    await proc.open('/cf/x', { read: true });
    await assert.rejects(files.releaseProcess(procPid), refused('EIO'));
  } finally {
    files.vfs.unmount('/cf');
  }
});

await check('a description whose flush fails still closes the file its backend holds open', async () => {
  let closed = 0;
  const unwritable = (opened, path) => ({
    write: () => { throw new VfsError('ENOTSUP', 'not in place', path); },
    close: () => { closed++; return opened.close(); },
  });
  const backend = credentialed('kept');
  files.vfs.mount('/uf', reopening(backend, unwritable));
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/uf/x', { read: true, write: true });
    proc.write(fd.id, 0, enc.encode('ab'));
    assert.throws(() => proc.close(fd.id), refused('ENOTSUP'));
    assert.equal(closed, 1, 'its backend\'s open file is closed');
    assert.equal(dec.decode(backend.readFile('/x')), 'kept', 'and a failed whole-file write left the file as it was');
  } finally {
    files.vfs.unmount('/uf');
  }
});

await check('a re-sent open of a description on an awaiting mount stops with its process', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('x'));
  let gate = null;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/rs', asyncOnly(backend, { deep: true, beforeCall: (method) => (gate !== null && method === 'stat' ? (entered(), gate) : undefined) }));
  const procPid = ++pid;
  const send = waveOf(files.bind({ pid: procPid, cred: USER }), { sequence: { writer: `${procPid}:w`, first: 1, ack: 0, pid: procPid } });
  const open = [{ type: 'call', call: { call: 'open', path: 'rs/x', mode: 0o644, read: true, description: 'd1' } }];
  let release = () => {};
  try {
    assert.equal((await send(open)).ok, true);
    gate = new Promise((resolve) => { release = resolve; });
    const resent = send(open);
    await entering;
    await files.releaseProcess(procPid).catch(() => {});
    const answer = await Promise.race([resent, new Promise((resolve) => setTimeout(() => resolve('stuck'), 1000))]);
    assert.notEqual(answer, 'stuck', 'the re-sent open answers once its process is released');
  } finally {
    release();
    gate = null;
    files.vfs.unmount('/rs');
  }
});

await check('a held write overlays its file through a source that wraps the same store anew each time', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('0123'));
  // A wrapper that keeps its receiver: a getter of the backend's is asked of the wrapper.
  const wrapped = () => new Proxy(backend, {
    get(target, key, receiver) {
      if (key === 'writeRange') return undefined;
      if (key === 'sync') return receiver;
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has: (target, key) => key !== 'writeRange' && key in target,
  });
  files.vfs.mount('/fw', wrapped);
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = proc.open('/fw/x', { read: true, write: true });
    proc.write(fd.id, 0, enc.encode('ab'));
    assert.equal(dec.decode(proc.readFile('/fw/x')), 'ab23', 'a path read through another wrapper of its store');
    proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/x')), 'ab23');
  } finally {
    files.vfs.unmount('/fw');
  }
});

await check('a change through a file its mount keeps open, queued behind a rename of it, is guarded where the rename put it', async () => {
  const backend = credentialed();
  for (const dir of ['/free', '/leased']) { backend.mkdir(dir); backend.chown(dir, 1000, 1000); }
  backend.rename('/x', '/free/x');
  let gate = null;
  let entered;
  const entering = new Promise((resolve) => { entered = resolve; });
  files.vfs.mount('/qm', asyncOnly(backend, { deep: true, hide: ['observeWrites'], beforeCall: (method) => (gate !== null && method === 'rename' ? (entered(), gate) : undefined) }));
  const stop = files.vfs.observeWrites(() => {});
  let lease = null;
  try {
    const proc = files.bind({ pid: ++pid, cred: USER });
    const fd = await proc.open('/qm/free/x', { read: true, write: true });
    let release;
    gate = new Promise((resolve) => { release = resolve; });
    const renaming = proc.rename('/qm/free/x', '/qm/leased/x');
    await entering;
    lease = files.engine.acquireExclusiveMutation('qm/leased');
    const writing = assert.rejects(async () => proc.write(fd.id, 0, enc.encode('NO')), refused('EBUSY'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await renaming;
    await writing;
    assert.equal(dec.decode(backend.readFile('/leased/x')), 'x');
    await proc.close(fd.id);
  } finally {
    if (lease !== null) files.engine.releaseExclusiveMutation(lease.owner);
    gate = null;
    stop();
    files.vfs.unmount('/qm');
  }
});

await check('a wave\'s close of a mounted description answers what its backend\'s close failed with', async () => {
  const failing = (opened, path) => ({ close: async () => { await opened.close(); throw new VfsError('EIO', 'the backend failed its close', path); } });
  files.vfs.mount('/cw', reopening(credentialed(), failing, false));
  const wave = waveOf(files.bind({ pid: ++pid, cred: USER }));
  try {
    const opened = await wave([{ type: 'call', call: { call: 'open', path: 'cw/x', mode: 0o644, read: true, description: 'd1' } }]);
    assert.equal(opened.ok, true, JSON.stringify(opened.error));
    const closed = await wave([{ type: 'call', call: { call: 'close', path: 'cw/x', description: 'd1' } }]);
    assert.equal(closed.ok, false);
    assert.equal(closed.error.errno, 'EIO');
    const after = await wave([{ type: 'call', call: { call: 'write', path: 'cw/x', description: 'd1', offset: 0, data: enc.encode('NO') } }]);
    assert.equal(after.error?.errno, 'EBADF', 'and it is closed all the same');
  } finally {
    files.vfs.unmount('/cw');
  }
});

await check('a killed process\'s descriptions close the files their mount holds open, writing nothing', async () => {
  let closed = 0;
  const counted = (opened) => ({ close: () => { closed++; return opened.close(); } });
  files.vfs.mount('/kf', reopening(credentialed(), counted));
  try {
    const procPid = ++pid;
    const proc = files.bind({ pid: procPid, cred: USER });
    proc.open('/kf/x', { read: true });
    files.killProcess(procPid);
    assert.equal(closed, 1);
  } finally {
    files.vfs.unmount('/kf');
  }
});

await check('a mounted description that takes an id the session kept for a file here leaves nothing of that one to adopt', async () => {
  const backend = new MemoryVFS({ uid: 1000, gid: 1000 });
  backend.writeFile('/x', enc.encode('there'));
  files.vfs.mount('/ri', backend);
  const procPid = ++pid;
  const proc = files.bind({ pid: procPid, cred: USER });
  proc.writeFile('/home/user/ri.txt', 'here');
  const at = (first) => waveOf(proc, { sequence: { writer: `${procPid}:w`, first, ack: first - 1, pid: procPid } });
  try {
    assert.equal((await at(1)([{ type: 'call', call: { call: 'open', path: 'home/user/ri.txt', mode: 0o644, read: true, description: 'd1' } }])).ok, true);
    assert.equal((await at(2)([{ type: 'call', call: { call: 'open', path: 'ri/x', mode: 0o644, read: true, description: 'd1' } }])).ok, true);
    assert.equal((await at(3)([{ type: 'call', call: { call: 'close', path: 'ri/x', description: 'd1' } }])).ok, true);
    const late = await at(4)([{ type: 'call', call: { call: 'write', path: 'home/user/ri.txt', description: 'd1', offset: 0, data: enc.encode('NO') } }]);
    assert.equal(late.error?.errno ?? late.sequence?.refused?.errno, 'EBADF');
    assert.equal(dec.decode(proc.readFile('/home/user/ri.txt')), 'here');
  } finally {
    files.vfs.unmount('/ri');
  }
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
