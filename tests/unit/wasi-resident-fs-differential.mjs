#!/usr/bin/env bun
/**
 * wasi-resident-fs-differential — every call a WASI process's filesystem
 * adapter answers from its store (core runtime/wasi/resident-filesystem.ts)
 * must answer as the authority does.
 *
 * One SqliteVFS, one process bridge (the authority a WASI facet reaches over
 * the supervisor), and the adapter in front of that bridge over the real
 * shipped store source (worker vfs/facet-resident-store.ts), its namespace
 * listed on demand through the same supervisor surface a facet has. Each
 * probe runs both ways and the answers are compared: stats field by field,
 * bytes, listings, link text, realpaths, descriptors, and the errno of every
 * refusal. Then the adapter mutates (its barrier is owed after each change),
 * and a peer mutates and input arrives (`inbound`), and every probe runs again.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const files = new ProcessFiles(engine);
const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
const authority = files.bind({ pid: 2, cred: USER });

// ── the tree ────────────────────────────────────────────────────────────────
const big = new Uint8Array(2 * 1024 * 1024 + 17);
for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
const k = (p) => `/${ROOT}/${p}`;
for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
await kernel.chown(`/${ROOT}`, 1000, 1000);
for (const dir of ['sub', 'sub/deep', 'secret', 'empty', 'many']) await kernel.mkdir(k(dir));
await kernel.writeFile(k('a.txt'), enc.encode('hello'));
await kernel.writeFile(k('big.bin'), big);
await kernel.writeFile(k('sub/b.txt'), enc.encode('b'));
await kernel.writeFile(k('sub/deep/c.txt'), enc.encode('c'.repeat(70_000)));
await kernel.writeFile(k('secret/x.txt'), enc.encode('x'));
await kernel.writeFile(k('locked.txt'), enc.encode('locked'));
await kernel.writeFile(k('ü file.txt'), enc.encode('unicode'));
for (let i = 0; i < 1500; i++) await kernel.writeFile(k(`many/f${i}`), enc.encode(String(i)));
await kernel.symlink('a.txt', k('l-rel'));
await kernel.symlink(`/${ROOT}/sub/b.txt`, k('l-abs'));
await kernel.symlink('sub', k('l-dir'));
await kernel.symlink('nope', k('l-dangling'));
await kernel.symlink('l-loop2', k('l-loop1'));
await kernel.symlink('l-loop1', k('l-loop2'));
await kernel.symlink('../../etc', k('l-escape'));
await kernel.chown(k('secret'), 2000, 2000);
await kernel.chmod(k('secret'), 0o700);
await kernel.chown(k('locked.txt'), 2000, 2000);
await kernel.chmod(k('locked.txt'), 0o600);
for (const p of ['a.txt', 'big.bin', 'sub', 'sub/b.txt', 'sub/deep', 'sub/deep/c.txt', 'empty', 'many', 'ü file.txt']) await kernel.chown(k(p), 1000, 1000);

// ── the store, as a facet holds it ─────────────────────────────────────────
const store = new Function(
  FACET_RESIDENT_STORE_SOURCE
    + '\nreturn { __residentBindInMemory, __residentSetStorage, __residentBootLazy, __residentNamespaceView };',
)();
store.__residentBindInMemory(64 * 1024 * 1024);
/** The supervisor surface a WASI facet has, answered by the process bridge (its errors as the RPC delivers them). */
const calls = { total: 0 };
const supervisor = {
  fsAcquire: (...args) => { calls.total++; return authority.acquire(...args); },
  fsList: (...args) => { calls.total++; return authority.list(...args); },
  readdir: (path) => { calls.total++; return authority.readdir(path); },
  readlink: (path) => { calls.total++; return authority.readlink(path); },
  stat: (path, options) => { calls.total++; return authority.stat(path, options); },
  async fsReadBatch(requests) {
    calls.total++;
    const out = [];
    for (const request of requests) {
      try {
        if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
        else out.push({ bytes: await authority.readRange(request.path, request.offset, request.length) });
      } catch (error) { out.push({ error }); }
    }
    return out;
  },
};
store.__residentSetStorage(undefined, supervisor);
assert.equal(await store.__residentBootLazy(supervisor), true, 'the lazy namespace boots on the authority cursor');
const device = (await authority.stat('/')).dev;
const adapter = residentFilesystem(authority, store.__residentNamespaceView(supervisor, device, USER));

// ── answers, comparable ─────────────────────────────────────────────────────
const digest = (bytes) => (bytes === null ? null : `${bytes.byteLength}:${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`);
/**
 * What a guest can observe of a stat (the codec writes dev, ino, type,
 * nlink, size and the times; permission checks read mode, uid and gid), and
 * a file's revision, which the codec keys its resident copies by. A
 * directory's revision is a subtree watermark nothing in the guest reads.
 */
function statShape(st, { revision = true } = {}) {
  if (st === null) return null;
  const shape = {
    dev: st.dev, ino: st.ino, nlink: st.nlink, type: st.type, size: st.size,
    atime: st.atime, mtime: st.mtime, ctime: st.ctime, mode: st.mode, uid: st.uid, gid: st.gid,
  };
  return revision && st.type === 'file' ? { ...shape, revision: st.revision } : shape;
}
async function outcome(fn) {
  try { return { value: await fn() }; }
  catch (error) {
    if (typeof error?.code !== 'string') throw error;
    return { error: error.code };
  }
}
const beneath = (path) => ({ root: ROOT, path, beneath: true });

const PATHS = [
  'a.txt', 'big.bin', 'sub', 'sub/b.txt', 'sub/deep/c.txt', 'l-rel', 'l-abs', 'l-dir', 'l-dir/b.txt',
  'l-dir/deep/c.txt', 'l-dangling', 'l-loop1', 'l-escape', 'secret', 'secret/x.txt', 'locked.txt', 'empty',
  'many', 'many/f777', 'nope', 'nope/x', 'sub/../a.txt', '..', '../user/a.txt', '/abs', 'ü file.txt', '.',
  'sub/./b.txt', 'a.txt/x', 'sub/deep/', 'new.txt', 'newdir', 'a2.txt', 'ext.txt', 'l-new',
];

async function probe(fs, path) {
  const p = beneath(path);
  const result = {
    stat: await outcome(async () => statShape(await fs.stat(p))),
    lstat: await outcome(async () => statShape(await fs.stat(p, { followSymlinks: false }))),
    readFile: await outcome(async () => digest(await fs.readFile(p))),
    readdir: await outcome(async () => (await fs.readdir(p)).map((e) => `${e.name}:${e.type}`).join(',')),
    readlink: await outcome(() => fs.readlink(p)),
    realpath: await outcome(() => fs.realpath(p)),
  };
  for (const directory of [false, true]) {
    result[directory ? 'openDir' : 'openFile'] = await outcome(async () => {
      const handle = await fs.open(p, { read: true, directory });
      try {
        const st = await fs.fstat(handle.id);
        // A descriptor's stat: the codec writes it out and reads its type, never its revision.
        const shape = { stat: statShape(st, { revision: false }), path: handle.path };
        if (st.type === 'directory') {
          shape.entries = (await fs.readdirHandle(handle.id)).map((e) => e.name).join(',');
        } else {
          shape.head = digest(await fs.read(handle.id, null, 10));
          shape.at = await fs.seek(handle.id, 0, 'current');
          shape.tail = digest(await fs.read(handle.id, Math.max(0, st.size - 5), 100));
          shape.end = await fs.seek(handle.id, -3, 'end');
          shape.rest = digest(await fs.read(handle.id, null, 100));
        }
        return shape;
      } finally {
        await fs.close(handle.id);
      }
    });
  }
  return result;
}

let compared = 0;
async function compareAll(phase) {
  const failures = [];
  for (const path of PATHS) {
    const expected = await probe(authority, path);
    const got = await probe(adapter, path);
    for (const op of Object.keys(expected)) {
      compared++;
      const a = JSON.stringify(expected[op]);
      const b = JSON.stringify(got[op]);
      if (a !== b) failures.push(`${phase} ${op} ${JSON.stringify(path)}:\n    authority ${a}\n    adapter   ${b}`);
    }
  }
  // A string path (a preopen's own root) and a path relative to an open directory.
  for (const [label, fn] of [
    ['readdir(string root)', async (fs) => (await fs.readdir(ROOT)).map((e) => e.name).join(',')],
    ['stat(string)', async (fs) => statShape(await fs.stat(`${ROOT}/sub/b.txt`))],
    ['stat(dir handle)', async (fs) => {
      const dir = await fs.open(beneath('sub'), { read: true, directory: true });
      try { return statShape(await fs.stat({ directory: dir.id, path: 'deep/c.txt', beneath: true })); }
      finally { await fs.close(dir.id); }
    }],
  ]) {
    compared++;
    const a = JSON.stringify(await outcome(() => fn(authority)));
    const b = JSON.stringify(await outcome(() => fn(adapter)));
    if (a !== b) failures.push(`${phase} ${label}:\n    authority ${a}\n    adapter   ${b}`);
  }
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 30)) console.log(`FAIL ${failure}`);
    console.log(`wasi-resident-fs-differential: ${failures.length} disagreements in phase ${phase}`);
    process.exit(1);
  }
}

// A deep name costs one round trip to learn, not a listing per directory on the way.
{
  const before = calls.total;
  const st = await adapter.stat(beneath('sub/deep/c.txt'));
  assert.equal(st?.size, 70_000);
  assert.equal(calls.total - before, 1, 'a cold stat four names deep is one lookup batch');
  // The stat brought the file's bytes: the open and read that follow it cost nothing.
  const handle = await adapter.open(beneath('sub/deep/c.txt'), { read: true });
  assert.equal((await adapter.read(handle.id, 0, 100_000)).byteLength, 70_000);
  await adapter.close(handle.id);
  assert.equal(calls.total - before, 1, 'an open and read after the stat take no round trip');
  // A file over the lookup's content bound is read when it is opened.
  await adapter.stat(beneath('big.bin'));
  const afterStat = calls.total;
  await adapter.readFile(beneath('big.bin'));
  assert.equal(calls.total - afterStat, 1, 'a large file is fetched by its own read');
}

await compareAll('cold');
const coldCalls = calls.total;
await compareAll('warm');
assert.equal(calls.total, coldCalls, 'a warm namespace answers every probe without a call to the authority');

// The process changes things through the adapter: what it reads next includes them.
await adapter.writeFile(beneath('new.txt'), enc.encode('fresh'));
await adapter.mkdir(beneath('newdir'));
await adapter.rename(beneath('a.txt'), beneath('a2.txt'));
await adapter.unlink(beneath('sub/b.txt'));
await adapter.symlink('a2.txt', beneath('l-new'));
const handle = await adapter.open(beneath('big.bin'), { read: true, write: true });
await adapter.write(handle.id, 0, enc.encode('XYZ'));
await adapter.close(handle.id);
await compareAll('own-writes');

// A file the process creates or truncates is held until close (HeldWrite):
// the process reads its own bytes back at once, a peer sees them from the
// close, and they arrive as the program wrote them, seeks and holes included.
{
  const out = await adapter.open(beneath('out.o'), { read: true, write: true, create: true, truncate: true });
  await adapter.write(out.id, null, enc.encode('header..'));
  await adapter.seek(out.id, 100, 'set');
  await adapter.write(out.id, null, enc.encode('tail'));
  await adapter.write(out.id, 2, enc.encode('XX'));
  const expected = new Uint8Array(104);
  expected.set(enc.encode('header..'));
  expected.set(enc.encode('tail'), 100);
  expected.set(enc.encode('XX'), 2);
  assert.equal((await adapter.fstat(out.id)).size, 104, 'fstat of a held file reports what was written');
  assert.deepEqual(await adapter.read(out.id, 0, 200), expected, 'a held file reads back through its descriptor');
  assert.deepEqual(await adapter.readFile(beneath('out.o')), expected, 'and by name, before close');
  assert.equal((await adapter.stat(beneath('out.o'))).size, 104, 'and stats at its held size');
  assert.equal((await authority.stat(beneath('out.o'))).size, 0, 'a peer sees the file from the open, empty until close');
  assert.equal(await adapter.seek(out.id, 0, 'current'), 104, 'the position is where the program left it');
  const wo = await adapter.open(beneath('wo.txt'), { write: true, create: true, truncate: true });
  await assert.rejects(async () => adapter.read(wo.id, 0, 1), { code: 'EBADF' }, 'a write-only held descriptor refuses a read');
  await adapter.write(wo.id, null, enc.encode('w'));
  await adapter.ftruncate(wo.id, 5);
  await adapter.close(wo.id);
  await adapter.close(out.id);
  assert.deepEqual(await authority.readFile(beneath('out.o')), expected, 'after close the session holds exactly the bytes');
  assert.deepEqual(await authority.readFile(beneath('wo.txt')), new Uint8Array([119, 0, 0, 0, 0]), 'a truncate past the end leaves zeros');
  PATHS.push('out.o', 'wo.txt');
}
await compareAll('held-writes');

// A peer changes things, then input arrives: the barrier brings them in.
await kernel.writeFile(k('ext.txt'), enc.encode('external'));
await kernel.writeFile(k('a2.txt'), enc.encode('rewritten by a peer'));
await kernel.remove(k('sub/deep'), { recursive: true });
await kernel.chmod(k('empty'), 0o700);
await kernel.chown(k('empty'), 2000, 2000);
adapter.inbound();
await compareAll('peer-writes');

console.log(`wasi-resident-fs-differential: ${compared} answers agree with the authority across cold, warm, own-write, held-write and peer-write phases`);
