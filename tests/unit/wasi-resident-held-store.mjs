#!/usr/bin/env bun
/**
 * wasi-resident-held-store — a WASI process that holds a subtree, over the
 * real resident store (vfs/resident/index.ts) rather than a test double:
 * what it decided is what it reads, lists and stats there.
 *
 * Red before (live, wasi-fs-load, python):
 *   - a second run that rewrote files a first run had written listed its
 *     directory as empty and stat'd the files it had just written as missing;
 *   - a 2 to 5 MiB file read back right after it was written had no bytes;
 *   - pip's first file in a package directory it had just made failed
 *     ENOENT when the grant was renewed while the open's walk waited.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
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

/**
 * A process of `session` (its own pid) over its own real store, holding what
 * it writes. `gate`: each wave waits for it. `grantInos`: a first grant's
 * range. `looked`, `caught`: each lookup's and each barrier's answer waits
 * for it, taken as the session had it when asked.
 */
async function processOf(session, gate = () => null, { grantInos, looked, caught } = {}) {
  const authority = session.files.bind({ pid: session.next++, cred: USER });
  const storeSource = createResidentStore();
  storeSource.bindInMemory(WASI_RESIDENT_STORE_BYTES);
  const supervisor = {
    async fsAcquire(...args) {
      const answer = await authority.acquire(...args);
      await caught?.();
      return answer;
    },
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
      await looked?.(requests);
      return out;
    },
  };
  storeSource.admission.setStorage(undefined, supervisor);
  assert.equal(await storeSource.view.bootLazy(supervisor), true);
  const root = await authority.stat('/');
  const view = storeSource.view.namespaceView(supervisor, root, USER);
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
    ...(grantInos === undefined ? {} : { grantInos }),
  });
  return { fs, kernel: session.kernel, authority };
}

/** A session with `seed`, and one process of it. */
async function processOver(seed = {}, gate, options) {
  return processOf(await sessionWith(seed), gate, options);
}

/** `gate`, or 300 ms if it never opens (a run whose walk takes no step the test opens it at). */
const held = (gate) => Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 300))]);

/** Resolves once `ready()` answers, polling. */
async function until(ready, what) {
  for (let i = 0; i < 400; i++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never: ${what}`);
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

// ── A stat answers the size this process's writes gave the file, whatever the session has of them yet ──
// Its sends held: each stat after a write answers as the writes made the
// file, and the session has them all once they are sent.
{
  const sent = Promise.withResolvers();
  let holding = false;
  const gate = () => (holding ? sent.promise : null);
  const { fs, authority } = await processOver({ 'seen.txt': 'x' }, gate);
  await fs.stat(beneath('seen.txt'));
  const handle = await fs.open(beneath('owed.txt'), { write: true, create: true, truncate: true });
  holding = true;
  await fs.write(handle.id, null, enc.encode('a'));
  assert.equal((await fs.stat(beneath('owed.txt'))).size, 1, 'a stat after a write answered without it');
  await fs.write(handle.id, null, enc.encode('bb'));
  assert.equal((await fs.stat(beneath('owed.txt'))).size, 3, 'a stat after a second write answered without it');
  holding = false;
  sent.resolve();
  await fs.close(handle.id);
  await fs.settle();
  assert.equal((await authority.stat(beneath('owed.txt'))).size, 3);
}

// ── A grant given back while a walk waits on the session: the walk reads what the process made ──
// pip's wheel install (python/numpy-flask-startup-modules, staging): a
// package's directory is made under the grant, the last of its range, so the
// grant is renewed; the first file's open walks the session for its name
// (the directory is not sent yet), and while that lookup waits, the renewal
// sends the log, gives the grant back and drops what was decided under it.
// Red before: the walk went on over the store's listing from before the
// directory was sent, and the open failed ENOENT.
{
  let holding = false;
  const sent = Promise.withResolvers();
  let proc;
  let lookups = 0;
  const looked = async (requests) => {
    if (!requests.some((request) => request.path.endsWith('/site/b/f0.py')) || ++lookups !== 2) return;
    holding = false;
    sent.resolve();
    await until(() => proc.fs.stats().client.released > 0, 'the grant given back');
  };
  proc = await processOver({ 'site/seen.txt': 'x' }, () => (holding ? held(sent.promise) : null), { grantInos: 4, looked });
  const { fs, authority } = proc;
  await fs.readdir(beneath('site'));
  for (let i = 0; i < 8; i++) await fs.mkdir(beneath(`site/w${i}`));
  await until(() => fs.stats().client.grants > 0, 'the subtree taken');
  await fs.mkdir(beneath('site/a'));
  // The range's numbers: the directory and the files decided in it (the first is the session's, its directory not sent yet).
  for (let i = 0; i < 3; i++) await rewrite(fs, `site/a/f${i}.py`, enc.encode(`a${i}`));
  holding = true;
  await fs.mkdir(beneath('site/b'));
  await rewrite(fs, 'site/b/f0.py', enc.encode('b0'));
  assert.equal(fs.stats().client.renewed, 1, 'the grant was not renewed while the walk waited');
  await fs.settle();
  assert.equal(dec.decode(await authority.readFile(beneath('site/b/f0.py'))), 'b0');
}

// ── A grant given back while the walk's barrier waits: the walk catches up again ──
// As above, but the walk owes a barrier already (input arrived), and the
// renewal gives the grant back while that barrier waits on the session, so
// the barrier answers from before the directory was sent. Red before: its
// landing cleared the debt the give-back made too, and the walk read the
// old listing (ENOENT).
{
  let holding = false;
  const sent = Promise.withResolvers();
  let proc;
  let armed = false;
  const caught = async () => {
    if (!armed) return;
    armed = false;
    holding = false;
    sent.resolve();
    await until(() => proc.fs.stats().client.released > 0, 'the grant given back');
  };
  proc = await processOver({ 'site/seen.txt': 'x' }, () => (holding ? held(sent.promise) : null), { grantInos: 4, caught });
  const { fs, authority } = proc;
  await fs.readdir(beneath('site'));
  for (let i = 0; i < 8; i++) await fs.mkdir(beneath(`site/w${i}`));
  await until(() => fs.stats().client.grants > 0, 'the subtree taken');
  await fs.mkdir(beneath('site/a'));
  for (let i = 0; i < 3; i++) await rewrite(fs, `site/a/f${i}.py`, enc.encode(`a${i}`));
  holding = true;
  await fs.mkdir(beneath('site/b'));
  fs.inbound();
  armed = true;
  await rewrite(fs, 'site/b/f0.py', enc.encode('b0'));
  assert.equal(armed, false, 'the walk took no barrier');
  assert.equal(fs.stats().client.renewed, 1, 'the grant was not renewed while the barrier waited');
  await fs.settle();
  assert.equal(dec.decode(await authority.readFile(beneath('site/b/f0.py'))), 'b0');
}

// ── A directory's descriptor lists it after a grant given back during its barrier ──
// A directory opened by descriptor (the session's, no pool), a directory
// made in it under the grant; input owes a barrier, and the renewal gives the
// grant back while that barrier waits, which answers from before the new
// directory was sent. Red before: its landing let the listing be served,
// over the old one, without the new directory.
{
  let holding = false;
  const sent = Promise.withResolvers();
  let proc;
  let armed = false;
  const caught = async () => {
    if (!armed) return;
    armed = false;
    holding = false;
    sent.resolve();
    await until(() => proc.fs.stats().client.released > 0, 'the grant given back');
  };
  proc = await processOver({ 'site/seen.txt': 'x' }, () => (holding ? held(sent.promise) : null), { grantInos: 4, caught });
  const { fs } = proc;
  await fs.readdir(beneath('site'));
  for (let i = 0; i < 8; i++) await fs.mkdir(beneath(`site/w${i}`));
  await until(() => fs.stats().client.grants > 0, 'the subtree taken');
  await fs.mkdir(beneath('site/a'));
  for (let i = 0; i < 3; i++) await rewrite(fs, `site/a/f${i}.py`, enc.encode(`a${i}`));
  const dir = await fs.open(beneath('site'), { read: true, directory: true });
  holding = true;
  await fs.mkdir(beneath('site/b'));
  fs.inbound();
  armed = true;
  const names = (await fs.readdirHandle(dir.id)).map((entry) => entry.name);
  assert.equal(armed, false, 'the listing took no barrier');
  assert.equal(fs.stats().client.renewed, 1, 'the grant was not renewed while the barrier waited');
  assert.ok(names.includes('b'), `the directory made under the grant is not listed: ${names.join(' ')}`);
  await fs.close(dir.id);
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
