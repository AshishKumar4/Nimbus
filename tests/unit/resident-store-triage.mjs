#!/usr/bin/env bun
/**
 * resident-store-triage — what the resident filesystem (core
 * runtime/wasi/resident-filesystem.ts) answers over a store listed on demand,
 * as a WASI process has it, when the session's replies land late or a peer
 * changes what the store already learned:
 *
 * - a lookup's reply, asked before a peer removed the file and landing after
 *   a barrier admitted the removal, never brings the file back;
 * - nor does a listing's;
 * - a change the process made through the session (outside any grant) is
 *   what its next call reads;
 * - a name the store learned under a directory a peer replaced is not
 *   served once the barrier admitted the replacement.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';
const k = (p) => `/${ROOT}/${p}`;

/**
 * A fresh session with `tree` (path → content, or null for a directory) under
 * the user's home, and the resident filesystem over a store listed on demand.
 * `hold(name)` parks the next reply of that supervisor call: computed when
 * asked, delivered when released.
 */
async function session(tree) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
  const authority = files.bind({ pid: 2, cred: USER });
  for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
  await kernel.chown(`/${ROOT}`, 1000, 1000);
  for (const [path, content] of Object.entries(tree)) {
    if (content === null) await kernel.mkdir(k(path), { recursive: true });
    else await kernel.writeFile(k(path), enc.encode(content));
    await kernel.chown(k(path), 1000, 1000);
  }
  const holds = new Map();
  const parked = [];
  const answered = async (name, compute) => {
    const answer = await compute();
    if (!holds.get(name)) return answer;
    holds.set(name, false);
    const release = Promise.withResolvers();
    parked.push({ name, release: () => release.resolve() });
    await release.promise;
    return answer;
  };
  const supervisor = {
    fsAcquire: (...args) => authority.acquire(...args),
    fsList: (...args) => authority.list(...args),
    readdir: (path) => answered('readdir', () => authority.readdir(path)),
    readlink: (path) => authority.readlink(path),
    stat: (path, options) => authority.stat(path, options),
    fsReadBatch: (requests) => answered('fsReadBatch', async () => {
      const out = [];
      for (const request of requests) {
        try {
          if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
          else out.push({ bytes: await authority.readRange(request.path, request.offset, request.length) });
        } catch (error) { out.push({ error }); }
      }
      return out;
    }),
  };
  const store = createResidentStore();
  store.bindInMemory(64 * 1024 * 1024);
  store.admission.setStorage(undefined, supervisor);
  assert.equal(await store.lazy.bootLazy(supervisor), true);
  const device = (await authority.stat('/')).dev;
  const fs = residentFilesystem(authority, store.lazy.namespaceView(supervisor, device, USER));
  /** Park the next reply of `name`, and wait until something asked it. */
  const hold = (name) => {
    holds.set(name, true);
    return async () => {
      for (let i = 0; i < 400 && !parked.some((p) => p.name === name); i++) await new Promise((r) => setTimeout(r, 2));
      assert.ok(parked.some((p) => p.name === name), `a ${name} was asked`);
    };
  };
  const release = (name) => {
    const at = parked.findIndex((p) => p.name === name);
    parked.splice(at, 1)[0].release();
  };
  return { kernel, authority, fs, hold, release };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];
const check = async (label, body) => {
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer in 10 s')), 10_000); });
  try { const note = await Promise.race([body(), hung]); console.log(`ok - ${label}${note ? ` (${note})` : ''}`); }
  catch (error) { failures.push(label); console.log(`not ok - ${label}: ${error.message}`); }
  finally { clearTimeout(timer); }
};
/** What a call that cannot wait reads of `path`: its stat, null where nothing is, or 'EAGAIN' where the view cannot say (a lazily listed view may refuse a name it does not know). */
const synchronously = (fs, path) => {
  try { return fs.synchronous.stat(path); }
  catch (error) { if (error?.code === 'EAGAIN') return 'EAGAIN'; throw error; }
};
const notServed = (fs, path, what) => {
  const seen = synchronously(fs, path);
  assert.ok(seen === null || seen === 'EAGAIN', `${what}: served ${JSON.stringify(seen)}`);
};
/** Whether `work` lands within `ms` (it may be waiting behind a reply that is parked). */
const landsWithin = (work, ms) => Promise.race([work.then(() => true), sleep(ms).then(() => false)]);

// A. A lookup asked before a peer removed the file, answered after a barrier admitted the removal.
await check('a late lookup reply never brings back a file a barrier saw removed', async () => {
  const s = await session({ d: null, 'd/f': 'f', other: 'o' });
  const asked = s.hold('fsReadBatch');
  const first = s.fs.stat(k('d/f'));
  await asked();
  await s.kernel.unlink(k('d/f'));
  s.fs.inbound();
  const barrier = s.fs.stat(k('other'));
  const landed = await landsWithin(barrier, 1_000);
  s.release('fsReadBatch');
  await first;
  await barrier;
  assert.equal(await s.fs.stat(k('d/f')), null, 'the file a peer removed, after the late lookup landed');
  notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of it');
  if (!landed) return 'unreachable: the barrier waited for the lookup';
});

// B. A listing whose stats were asked before a peer removed a file, answered after a barrier admitted the removal.
await check('a late listing never brings back a file a barrier saw removed', async () => {
  const s = await session({ d: null, 'd/f': 'f', 'd/g': 'g', other: 'o' });
  const asked = s.hold('fsReadBatch');
  const first = s.fs.readdir(k('d'));
  await asked();
  await s.kernel.unlink(k('d/f'));
  s.fs.inbound();
  const barrier = s.fs.stat(k('other'));
  const landed = await landsWithin(barrier, 1_000);
  s.release('fsReadBatch');
  await first;
  await barrier;
  const names = (await s.fs.readdir(k('d'))).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['g'], 'the directory a peer removed a file from, after the late listing landed');
  assert.equal(await s.fs.stat(k('d/f')), null, 'the file itself');
  notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of it');
  if (!landed) return 'unreachable: the barrier waited for the listing';
});

// C. A change made through the session, outside any grant, is what the next call reads.
await check('an awaited chmod through the session is what the next awaited stat reads', async () => {
  const s = await session({ a: 'a' });
  assert.equal((await s.fs.stat(k('a'))).mode & 0o777, 0o644);
  await s.fs.chmod(k('a'), 0o600);
  assert.equal((await s.fs.stat(k('a'))).mode & 0o777, 0o600);
});
await check('an awaited chmod through the session is what the next synchronous stat reads', async () => {
  const s = await session({ a: 'a' });
  assert.equal((await s.fs.stat(k('a'))).mode & 0o777, 0o644);
  await s.fs.chmod(k('a'), 0o600);
  const seen = synchronously(s.fs, k('a'));
  if (seen === 'EAGAIN') return 'refused: the view cannot say';
  assert.equal(seen.mode & 0o777, 0o600);
});

// D. A name learned under a directory a peer replaced is not served once the barrier admitted the replacement.
await check('a learned name under a directory a peer replaced is gone after the barrier', async () => {
  const s = await session({ d: null, 'd/f': 'f', x: null, 'x/g': 'g', other: 'o' });
  assert.notEqual(await s.fs.stat(k('d/f')), null);
  await s.kernel.rename(k('d'), k('d-old'));
  await s.kernel.rename(k('x'), k('d'));
  s.fs.inbound();
  await s.fs.stat(k('other'));
  assert.equal(await s.fs.stat(k('d/f')), null, 'the old directory\'s file, under the new one');
  assert.notEqual(await s.fs.stat(k('d/g')), null, 'the new directory\'s file');
  notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the old file');
});
await check('a learned name under a directory a peer made unsearchable is refused after the barrier', async () => {
  const s = await session({ d: null, 'd/f': 'f', other: 'o' });
  assert.notEqual(await s.fs.stat(k('d/f')), null);
  await s.kernel.chown(k('d'), 2000, 2000);
  await s.kernel.chmod(k('d'), 0o700);
  s.fs.inbound();
  await s.fs.stat(k('other'));
  await assert.rejects(() => s.fs.stat(k('d/f')), (error) => error.code === 'EACCES', 'the file under the directory it may no longer search');
});

if (failures.length > 0) {
  console.log(`resident-store-triage: ${failures.length} red: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('resident-store-triage: ok');
