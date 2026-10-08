#!/usr/bin/env bun
/**
 * wasi-resident-held-store — a WASI process that holds a subtree, over the
 * real resident store (facet-resident-store.ts) rather than a test double:
 * what it decided is what it reads, lists and stats there.
 *
 * Red before (live, wasi-fs-load, python):
 *   - a second run that rewrote files a first run had written listed its
 *     directory as empty and stat'd the files it had just written as missing;
 *   - a 2 to 5 MiB file read back right after it was written had no bytes.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { WASI_RESIDENT_STORE_BYTES } from '../../packages/platform/src/limits.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';
const beneath = (path) => ({ root: ROOT, path, beneath: true });
const k = (p) => `/${ROOT}/${p}`;

/** A session with `seed` (path -> text) written as the user's. */
async function sessionWith(seed = {}) {
  const harness = createSqliteVfsTestHarness();
  const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
  const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
  for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
  await kernel.chown(`/${ROOT}`, 1000, 1000);
  for (const [path, text] of Object.entries(seed)) {
    const at = path.lastIndexOf('/');
    if (at > 0) { await kernel.mkdir(k(path.slice(0, at)), { recursive: true }); await kernel.chown(k(path.slice(0, at)), 1000, 1000); }
    await kernel.writeFile(k(path), enc.encode(text));
    await kernel.chown(k(path), 1000, 1000);
  }
  return { files, kernel, next: 2 };
}

/** A process of `session` (its own pid) over its own real store, holding what it writes. `gate`: each wave waits for it. */
async function processOf(session, gate = () => null) {
  const authority = session.files.bind({ pid: session.next++, cred: USER });
  const storeSource = new Function(
    FACET_RESIDENT_STORE_SOURCE
      + '\nreturn { __residentBindInMemory, __residentSetStorage, __residentBootLazy, __residentNamespaceView };',
  )();
  storeSource.__residentBindInMemory(WASI_RESIDENT_STORE_BYTES);
  const supervisor = {
    fsAcquire: (...args) => authority.acquire(...args),
    fsList: (...args) => authority.list(...args),
    readdir: (path) => authority.readdir(path),
    readlink: (path) => authority.readlink(path),
    stat: (path, options) => authority.stat(path, options),
    async fsReadBatch(requests) {
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
  storeSource.__residentSetStorage(undefined, supervisor);
  assert.equal(await storeSource.__residentBootLazy(supervisor), true);
  const device = (await authority.stat('/')).dev;
  const view = storeSource.__residentNamespaceView(supervisor, device, USER);
  const port = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => {
      await gate();
      return authority.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner });
    },
    grants: {
      acquire: async (path, delegate) => authority.acquireExclusiveMutation(path, { delegate }),
      release: async (owner) => { authority.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => authority.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { authority.recalled(owner, kind); },
    },
  };
  // The grant comes as it does live (GRANT_AFTER): after the first changes went to the session.
  const fs = residentFilesystem(authority, view, {
    session: port,
    isHomeRoot: (key) => key.startsWith('home/') && !key.slice(5).includes('/'),
  });
  return { fs, kernel: session.kernel, authority };
}

/** A session with `seed`, and one process of it. */
async function processOver(seed = {}, gate) {
  return processOf(await sessionWith(seed), gate);
}

/** Python's open(name, 'w') and one write of `bytes`. */
async function rewrite(fs, name, bytes) {
  const handle = await fs.open(beneath(name), { write: true, create: true, truncate: true });
  await fs.write(handle.id, null, bytes);
  await fs.close(handle.id);
}

/** Python's open(name, 'rb').read(): its size, then its bytes. */
async function readWhole(fs, name) {
  const handle = await fs.open(beneath(name), { read: true });
  const { size } = await fs.fstat(handle.id);
  const parts = [];
  let at = 0;
  for (;;) {
    const chunk = await fs.read(handle.id, null, Math.max(size - at, 1));
    if (chunk.byteLength === 0) break;
    parts.push(chunk);
    at += chunk.byteLength;
  }
  await fs.close(handle.id);
  const out = new Uint8Array(at);
  let off = 0;
  for (const part of parts) { out.set(part, off); off += part.byteLength; }
  return out;
}

// ── A second run rewrites what a first left: it lists and stats what it wrote ──
{
  const N = 50;
  const seed = {};
  for (let i = 0; i < N; i++) seed[`many/f${String(i).padStart(4, '0')}.txt`] = String(i).repeat(1000);
  const { fs, authority } = await processOver(seed);
  await fs.stat(beneath('many'));
  for (let i = 0; i < N; i++) await rewrite(fs, `many/f${String(i).padStart(4, '0')}.txt`, enc.encode(String(i).repeat(1000)));
  fs.inbound();
  const names = await fs.readdir(beneath('many'));
  assert.equal(names.length, N, `a rewritten directory listed ${names.length} of ${N}`);
  assert.notEqual(await fs.stat(beneath('many/f0001.txt')), null, 'a file just rewritten was stat\'d as missing');
  assert.equal(dec.decode(await readWhole(fs, 'many/f0001.txt')), '1'.repeat(1000));
  await fs.settle();
  assert.equal((await authority.readdir(beneath('many'))).length, N);
}

// ── As live: a first process makes them under its grant, a second rewrites them without listing first ──
// Red before (live, python: `os.makedirs(d, exist_ok=True)`, then open(…, 'w') of
// each, then os.listdir): the second run listed the directory as empty and
// every file it had just written as missing.
{
  const N = 20;
  const session = await sessionWith();
  const names = Array.from({ length: N }, (_, i) => `d/f${String(i).padStart(4, '0')}.txt`);
  for (let run = 1; run <= 2; run++) {
    const { fs } = await processOf(session);
    await fs.mkdir(beneath('d'), { mode: 0o777 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    for (const [i, name] of names.entries()) await rewrite(fs, name, enc.encode(String(i).repeat(10)));
    // Input arrives (a poll wakeup, a socket's bytes): the next answer takes the barrier first.
    fs.inbound();
    const listed = await fs.readdir(beneath('d'));
    assert.equal(listed.length, N, `run ${run}: the directory it rewrote listed ${listed.length} of ${N}`);
    for (const name of [names[0], names[1], names[N - 1]]) assert.notEqual(await fs.stat(beneath(name)), null, `run ${run}: ${name}, just written, was stat'd as missing`);
    await fs.settle();
  }
}

// ── A write through made while a send is in flight is still owed after it ──
// Red before: the send's completion cleared the debt the new write logged
// during its await; the stat after it took the barrier without sending that
// write, and the store answered the size the session had: the old one.
{
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  let holding = false;
  let held = 0;
  const gate = () => (holding ? (held++ === 0 ? first.promise : second.promise) : null);
  const { fs } = await processOver({ 'seen.txt': 'x' }, gate);
  await fs.stat(beneath('seen.txt'));
  const handle = await fs.open(beneath('owed.txt'), { write: true, create: true, truncate: true });
  await fs.write(handle.id, null, enc.encode('a'));
  holding = true;
  const stat = fs.stat(beneath('owed.txt'));
  for (let i = 0; i < 200 && held === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(held, 1, 'the stat sent nothing first');
  // During the send: a write and the close (another thread's, or the program's own between the send's turns).
  await fs.write(handle.id, null, enc.encode('bb'));
  const closed = fs.close(handle.id);
  first.resolve();
  let answered = null;
  stat.then((value) => { answered = value; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  holding = false;
  second.resolve();
  const final = await stat;
  assert.equal((answered ?? final).size, 3, 'a stat after the send answered without the write made during it');
  await closed;
  await fs.settle();
}

// ── A file of a few MiB reads back what was written, at once ──
for (const mib of [1, 2, 3, 4, 5, 6]) {
  const { fs, authority } = await processOver({ 'seen.txt': 'x' });
  await fs.stat(beneath('seen.txt'));
  const big = new Uint8Array(mib * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096 + mib) & 0xff;
  await rewrite(fs, `big${mib}.bin`, big);
  const got = await readWhole(fs, `big${mib}.bin`);
  assert.equal(got.byteLength, big.byteLength, `${mib} MiB written, ${got.byteLength} bytes read back`);
  assert.deepEqual(got.subarray(0, 8192), big.subarray(0, 8192));
  await fs.settle();
  assert.equal((await authority.stat(beneath(`big${mib}.bin`))).size, big.byteLength);
}

console.log('wasi-resident-held-store: ok');
process.exit(0);
