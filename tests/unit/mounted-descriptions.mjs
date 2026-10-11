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

/** Each backend method a mount was asked, in order. */
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
  const refused = (code) => (error) => error.code === code;
  const seed = (name, text, mode = 0o644) => {
    backend.writeFile(`/${name}`, enc.encode(text));
    backend.chmod(`/${name}`, mode);
  };

  // Neither access asked is O_RDONLY: the descriptor reads.
  seed('plain', 'abc');
  {
    const fd = await proc.open(`${at}/plain`, {});
    assert.equal(dec.decode(await proc.read(fd.id, 0, 3)), 'abc', `${face}: an open asking no access reads`);
    await proc.close(fd.id);
  }

  // O_NOFOLLOW of a link is ELOOP; O_CREAT|O_EXCL of a link, even dangling, is EEXIST first.
  backend.symlink('/plain', '/link');
  backend.symlink('/nowhere', '/dangling');
  await assert.rejects(async () => proc.open(`${at}/link`, { followSymlinks: false }), refused('ELOOP'), `${face}: O_NOFOLLOW of a link`);
  await assert.rejects(async () => proc.open(`${at}/dangling`, { write: true, create: true, exclusive: true, followSymlinks: false }), refused('EEXIST'), `${face}: O_EXCL of a link`);
  assert.equal(backend.stat('/nowhere'), null);

  // O_DIRECTORY: ENOTDIR of a file; with O_CREAT of an absent name EINVAL, nothing made.
  await assert.rejects(async () => proc.open(`${at}/plain`, { directory: true }), refused('ENOTDIR'), `${face}: O_DIRECTORY of a file`);
  await assert.rejects(async () => proc.open(`${at}/made`, { write: true, create: true, directory: true }), refused('EINVAL'), `${face}: O_CREAT|O_DIRECTORY`);
  assert.equal(backend.stat('/made'), null, `${face}: O_CREAT|O_DIRECTORY makes nothing`);

  // A directory opens with write rights (a capability set), and refuses what would change its content.
  backend.mkdir('/dir');
  {
    const fd = await proc.open(`${at}/dir`, { write: true });
    assert.deepEqual(await proc.readdirHandle(fd.id), [], `${face}: a directory opened with write rights`);
    await proc.close(fd.id);
  }
  await assert.rejects(async () => proc.open(`${at}/dir`, { write: true, truncate: true }), refused('EISDIR'), `${face}: O_TRUNC of a directory`);

  // The access asked is checked against the file's mode before anything changes; a file the open makes is the opener's.
  seed('readonly', 'kept', 0o444);
  await assert.rejects(async () => proc.open(`${at}/readonly`, { write: true, truncate: true }), refused('EACCES'), `${face}: a read-only file, for writing`);
  assert.equal(dec.decode(backend.readFile('/readonly')), 'kept', `${face}: refused before it truncated`);
  {
    const fd = await proc.open(`${at}/readonly-new`, { write: true, create: true, exclusive: true, mode: 0o444 });
    await proc.write(fd.id, null, enc.encode('made'));
    await proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/readonly-new')), 'made', `${face}: creat(2) writes what it makes, whatever its mode`);
  }

  // O_TRUNC of a file is the mount's truncate, not a rewrite.
  seed('long', 'a long file');
  calls.length = 0;
  await proc.close((await proc.open(`${at}/long`, { write: true, truncate: true })).id);
  assert.equal(backend.readFile('/long').byteLength, 0);
  if (face === 'async') assert.ok(calls.includes('truncate') && !calls.includes('writeFile'), `async: O_TRUNC truncates (${calls})`);

  // O_APPEND: the offset starts at 0, and each append leaves it at the end.
  seed('log', '12345');
  {
    const fd = await proc.open(`${at}/log`, { write: true, append: true });
    assert.equal(await proc.seek(fd.id, 0, 'current'), 0, `${face}: an append descriptor starts at 0`);
    await proc.write(fd.id, null, enc.encode('67'));
    assert.equal(await proc.seek(fd.id, 0, 'current'), 7, `${face}: and is left at the end`);
    await proc.close(fd.id);
    assert.equal(dec.decode(backend.readFile('/log')), '1234567');
  }

  // fstat of a mounted file is the mount's: revision 0, the SQLite clock untouched.
  {
    const fd = await proc.open(`${at}/plain`, { read: true });
    assert.equal((await proc.fstat(fd.id)).revision, 0, `${face}: a mounted fstat carries revision 0`);
    // Offsets: a negative one reads from 0; a seek to no integer, or by an unknown whence, is EINVAL.
    assert.equal(dec.decode(await proc.read(fd.id, -5, 2)), 'ab', `${face}: a negative offset reads from 0`);
    await assert.rejects(async () => proc.seek(fd.id, 0.5, 'set'), refused('EINVAL'), `${face}: a seek to no integer`);
    await assert.rejects(async () => proc.seek(fd.id, 0, 'nowhere'), refused('EINVAL'), `${face}: an unknown whence`);
    // ftruncate of a descriptor not open for writing is EINVAL, and changes nothing.
    await assert.rejects(async () => proc.ftruncate(fd.id, 0), refused('EINVAL'), `${face}: ftruncate of a read-only descriptor`);
    assert.equal(dec.decode(backend.readFile('/plain')), 'abc');
    await proc.close(fd.id);
  }

  // One numbering: the synchronous face knows a descriptor on an asynchronous
  // mount, and refuses it as it refuses that mount; a dup shares it until its last close.
  {
    const fd = await proc.open(`${at}/plain`, { read: true });
    const dup = await proc.dup(fd.id);
    await proc.close(fd.id);
    if (face === 'async') {
      assert.throws(() => proc.synchronous.read(dup.id, 0, 1), (error) => error.code === 'EAGAIN' && error.asyncMount === true, 'async: the synchronous face refuses it as its mount');
    } else {
      assert.equal(dec.decode(proc.synchronous.read(dup.id, 0, 1)), 'a');
    }
    assert.equal(dec.decode(await proc.read(dup.id, 1, 2)), 'bc', `${face}: the dup outlives the descriptor it was made from`);
    await proc.close(dup.id);
    await assert.rejects(async () => proc.read(dup.id, 0, 1), refused('EBADF'));
  }
}

// A mount whose writeRange refuses (ENOTSUP) still takes a descriptor's
// writes: held, read back by the writing process, and written at the close.
{
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
  assert.equal(proc.write(fd.id, 2, enc.encode('ab')), 2, 'a write the mount cannot make in place is held');
  assert.equal(dec.decode(proc.read(fd.id, 0, 10)), '01ab456789', 'and read back by its process');
  assert.equal(dec.decode(backend.readFile('/x')), '0123456789', 'unwritten until the flush');
  proc.close(fd.id);
  assert.equal(dec.decode(backend.readFile('/x')), '01ab456789', 'written at the last close');
}

// On SQLite too, an O_APPEND descriptor starts at 0, and ftruncate of a read-only one is EINVAL.
{
  const proc = files.bind({ pid: ++pid, cred: USER });
  proc.writeFile('/home/user/sq.log', '12345');
  const fd = proc.open('/home/user/sq.log', { write: true, append: true });
  assert.equal(proc.seek(fd.id, 0, 'current'), 0, 'sqlite: an append descriptor starts at 0');
  proc.write(fd.id, null, enc.encode('67'));
  assert.equal(proc.seek(fd.id, 0, 'current'), 7);
  proc.close(fd.id);
  const ro = proc.open('/home/user/sq.log', { read: true });
  assert.throws(() => proc.ftruncate(ro.id, 0), (error) => error.code === 'EINVAL', 'sqlite: ftruncate of a read-only descriptor');
  proc.close(ro.id);
}

console.log('mounted-descriptions: ok');
