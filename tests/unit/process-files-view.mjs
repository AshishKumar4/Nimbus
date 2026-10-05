#!/usr/bin/env bun
// ProcessFiles.view(): what a command sees. A `VFS` over the process's own
// bound bridge, never the bare namespace: a mutation under another owner's
// lease is EBUSY, absence is a null stat, every failure is a VfsError with
// the syscall's code, and a mount answers through the same view.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { exists, isDirectory, readText, statOrThrow } from '../../packages/core/src/vfs/vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const code = async (run) => { try { await run(); return 'ok'; } catch (error) { assert.ok(isVfsError(error), String(error)); return error.code; } };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
engine.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
engine.as(CRED_KERNEL).chown('home/user', 1000, 1000);
const files = new ProcessFiles(engine);
const vfs = files.view({ pid: 10, cred: USER });

// Absence and errors.
assert.equal(await vfs.stat('/home/user/none'), null);
assert.equal(await exists(vfs, '/home/user/none'), false);
assert.equal(await code(() => statOrThrow(vfs, '/home/user/none')), 'ENOENT');
assert.equal(await code(() => vfs.readFile('/home/user/none')), 'ENOENT');
assert.equal(await code(() => vfs.writeFile('/x', enc.encode('x'))), 'EACCES', '/ is root 0755');

// Writes, appends, directories, the rm -r report.
await vfs.mkdir('/home/user/d/e', { recursive: true });
assert.ok(await isDirectory(vfs, '/home/user/d/e'));
await vfs.writeFile('/home/user/d/log', enc.encode('a'));
await Promise.all([vfs.appendFile('/home/user/d/log', enc.encode('b')), vfs.appendFile('/home/user/d/log', enc.encode('c'))]);
assert.equal((await readText(vfs, '/home/user/d/log')).length, 3, 'concurrent appends both land');
assert.equal(await code(() => vfs.access('/', 2)), 'EACCES');
assert.equal(await vfs.realpath('/home/user/d/../d/e'), '/home/user/d/e');
assert.deepEqual(await vfs.removeRecursive('/home/user/d'), { removed: ['/home/user/d'], kept: [], failures: [] });
assert.equal(await exists(vfs, '/home/user/d'), false);

// writeFile's mode applies at creation only, and atomically (open(O_CREAT, mode)).
await vfs.writeFile('/home/user/kept', enc.encode('a'));
await vfs.chmod('/home/user/kept', 0o644);
await vfs.writeFile('/home/user/kept', enc.encode('b'), { mode: 0o600 });
assert.equal(((await vfs.stat('/home/user/kept')).mode & 0o777).toString(8), '644', 'an existing file keeps its mode');
assert.equal(await readText(vfs, '/home/user/kept'), 'b');
const seen = [];
const watching = files.bind({ pid: 12, cred: USER });
const stop = watching.subscribe('/home/user/fresh', () => seen.push(watching.stat('/home/user/fresh')?.mode & 0o777));
await vfs.writeFile('/home/user/fresh', 'new text', { mode: 0o600 });
stop();
assert.equal(((await vfs.stat('/home/user/fresh')).mode & 0o777).toString(8), '600', 'a new file is created with the mode (minus umask)');
assert.ok(seen.every((mode) => mode === undefined || mode === 0o600), `never visible at another mode: ${seen.map((m) => m?.toString(8))}`);
await vfs.writeFile('/home/user/masked', 'x', { mode: 0o666 });
assert.equal(((await vfs.stat('/home/user/masked')).mode & 0o777).toString(8), '644', 'the umask applies');

// touch, chown -1, text appends, an uncached read.
await vfs.touch('/home/user/t');
assert.equal((await vfs.stat('/home/user/t')).size, 0);
await vfs.appendFile('/home/user/t', 'text');
assert.equal(new TextDecoder().decode(await vfs.readFileUncached('/home/user/t')), 'text');
await vfs.chown('/home/user/t', null, 1000);
assert.equal((await vfs.stat('/home/user/t')).uid, 1000, 'chown with a null uid keeps the owner');
assert.equal(await code(() => vfs.chown('/home/user/none', null, 1000)), 'ENOENT');

// Another owner's lease: the view goes through the process's bridge, so EBUSY.
await vfs.mkdir('/home/user/clone');
await vfs.writeFile('/home/user/clone/f', enc.encode('x'));
const cloner = files.bind({ pid: 11, cred: USER });
const lease = cloner.acquireExclusiveMutation('/home/user/clone');
const refused = await vfs.removeRecursive('/home/user/clone');
assert.deepEqual([refused.removed, refused.kept, refused.failures.map((f) => f.error.code)], [[], ['/home/user/clone'], ['EBUSY']], 'rm -r of a leased clone destination');
assert.equal(await code(() => vfs.writeFile('/home/user/clone/g', enc.encode('x'))), 'EBUSY');
assert.equal(await readText(vfs, '/home/user/clone/f'), 'x', 'nothing was removed');
cloner.releaseExclusiveMutation(lease.owner);
assert.deepEqual((await vfs.removeRecursive('/home/user/clone')).removed, ['/home/user/clone']);

// A mount answers through the same view.
const scratch = new MemoryVFS({ uid: 1000, gid: 1000 });
files.vfs.mount('/mnt/s', scratch);
await vfs.writeFile('/mnt/s/f', enc.encode('m'));
assert.equal(new TextDecoder().decode(scratch.readFile('/f')), 'm');
assert.deepEqual((await vfs.readdir('/mnt/s')).map((e) => e.name), ['f']);

// A descriptor on a mount that cannot write in place buffers its writes.
// The process that holds it sees them at once, as Linux's page cache makes a
// write visible (read on the descriptor, fstat, and read or stat by path);
// another process sees the mount's own content until the flush.
{
  const memory = new MemoryVFS({ uid: 1000, gid: 1000 });
  const inPlaceless = Object.assign(Object.create(memory), { writeRange: undefined });
  inPlaceless.sync = inPlaceless;
  files.vfs.mount('/mnt/buffered', inPlaceless);
  const writer = files.bind({ pid: 30, cred: USER });
  const other = files.bind({ pid: 31, cred: USER });
  const fd = writer.open('/mnt/buffered/f', { read: true, write: true, create: true });
  writer.write(fd.id, null, enc.encode('abc'));
  assert.equal(new TextDecoder().decode(writer.read(fd.id, 0, 16)), 'abc', 'read after write on the same descriptor');
  assert.equal(writer.fstat(fd.id).size, 3, 'fstat');
  assert.equal(writer.stat('/mnt/buffered/f').size, 3, 'stat by path, same process');
  assert.equal(new TextDecoder().decode(writer.readFile('/mnt/buffered/f')), 'abc', 'read by path, same process');
  assert.equal(other.stat('/mnt/buffered/f').size, 0, 'another process sees the mount until the flush');
  assert.equal(new TextDecoder().decode(other.readFile('/mnt/buffered/f')), '');
  writer.fsync(fd.id);
  assert.equal(new TextDecoder().decode(other.readFile('/mnt/buffered/f')), 'abc', 'and the write after it');
  writer.close(fd.id);
  files.vfs.unmount('/mnt/buffered');
}

// A backend that hands out its own buffer (no copy): a process's view never
// writes into it, so the mount's content is unchanged until the flush.
{
  const held = new Map([['/f', new Uint8Array([1, 2, 3])]]);
  const own = {
    stat: (p) => (held.has(p) ? { type: 'file', size: held.get(p).byteLength, mtimeMs: 0, mode: 0o100666, uid: 1000, gid: 1000 } : (p === '/' ? { type: 'directory', size: 0, mtimeMs: 0, mode: 0o40777, uid: 0, gid: 0 } : null)),
    readFile: (p) => held.get(p),
    writeFile: (p, bytes) => { held.set(p, bytes); },
    readdir: () => [...held.keys()].map((k) => ({ name: k.slice(1), type: 'file' })),
  };
  own.sync = own;
  files.vfs.mount('/mnt/own', own);
  const writer = files.bind({ pid: 32, cred: USER });
  const fd = writer.open('/mnt/own/f', { read: true, write: true });
  writer.write(fd.id, 0, new Uint8Array([9]));
  assert.deepEqual([...writer.read(fd.id, 0, 3)], [9, 2, 3]);
  assert.deepEqual([...held.get('/f')], [1, 2, 3], 'the backend\'s buffer is untouched before the flush');
  writer.close(fd.id);
  assert.deepEqual([...held.get('/f')], [9, 2, 3]);
  files.vfs.unmount('/mnt/own');
}

// writeFileFrom publishes a file whole once its bytes have arrived, on SQLite
// and on a mount alike; refused before a byte is read where writeFile would
// be refused, and nothing is published from a source that ends short.
{
  const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) & 0xff);
  let pulled = 0;
  const pieces = async function* (bytes, size = 70_001) {
    for (let at = 0; at < bytes.length; at += size) {
      pulled++;
      yield bytes.slice(at, at + size);
    }
  };
  await vfs.writeFileFrom('/home/user/streamed', big.length, pieces(big));
  assert.deepEqual(await vfs.readFile('/home/user/streamed'), big);
  assert.equal(((await vfs.stat('/home/user/streamed')).mode & 0o777).toString(8), '644', 'created as writeFile creates');
  await vfs.writeFileFrom('/mnt/s/streamed', big.length, pieces(big));
  assert.deepEqual(scratch.readFile('/streamed'), big, 'a mount takes the bytes through its own writes');
  assert.equal(await code(() => vfs.writeFileFrom('/home/user/short', big.length + 1, pieces(big))), 'EINVAL');
  assert.equal(await exists(vfs, '/home/user/short'), false, 'a source that ends short publishes nothing');
  pulled = 0;
  assert.equal(await code(() => vfs.writeFileFrom('/x', big.length, pieces(big))), 'EACCES');
  assert.equal(pulled, 0, 'a refused write reads nothing from its source');
}

// rewindProcess: a run of a live process ends and another starts in its
// place (worker runtime/stop-replay.ts). The run's descriptors close, their
// writes flushed; the pid stays live, and the next run's descriptors are
// numbered from the first again, as the run before's were.
{
  const errno = async (run) => { try { await run(); return 'ok'; } catch (error) { return error.code; } };
  const before = files.bind({ pid: 40, cred: USER });
  const first = before.open('/home/user/rewound', { read: true, write: true, create: true });
  before.write(first.id, null, enc.encode('kept'));
  await files.rewindProcess(40);
  assert.equal(await errno(async () => before.read(first.id, 0, 4)), 'EBADF', 'the run before\'s descriptor is closed');
  const after = files.bind({ pid: 40, cred: USER });
  const again = after.open('/home/user/rewound', { read: true });
  assert.equal(again.id, first.id, 'numbered as the run before\'s were');
  assert.equal(new TextDecoder().decode(after.read(again.id, 0, 4)), 'kept', 'its write was flushed');
  after.close(again.id);
  await files.releaseProcess(40);
  await files.rewindProcess(40);
  assert.equal(await errno(async () => files.bind({ pid: 40, cred: USER }).open('/home/user/rewound', { read: true })), 'ESTALE', 'a released pid is not brought back');
}

console.log('process-files-view: ok');
