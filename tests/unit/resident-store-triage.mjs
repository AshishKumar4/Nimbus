#!/usr/bin/env bun
/**
 * resident-store-triage — what a process's resident filesystem answers when
 * the session's replies land late, or a peer changes what its store already
 * learned:
 *
 * - a lookup's reply, asked before a peer removed the file and landing after
 *   a barrier admitted the removal, never brings the file back;
 * - nor does a listing's;
 * - a name the store learned under a directory a peer replaced is not
 *   served once the barrier admitted the replacement, on either engine.
 *
 * The first three run the resident filesystem (core
 * runtime/wasi/resident-filesystem.ts) over a store listed on demand, as a
 * WASI process has it, whose supervisor can park a reply: computed when
 * asked, delivered when released.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { runScenarios, sleep } from './lib/resident-body.mjs';
import { APP, ENGINES, bootEngine } from './lib/guest-engines.mjs';

const enc = new TextEncoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const ROOT = 'home/user';
const k = (p) => `/${ROOT}/${p}`;

/** A session with `tree` (path → content, or null for a directory) under the user's home, and the resident filesystem over a store listed on demand. */
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
  const holds = new Set();
  const parked = [];
  const answered = async (name, compute) => {
    const answer = await compute();
    if (!holds.delete(name)) return answer;
    const release = Promise.withResolvers();
    parked.push({ name, release: release.resolve });
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
  return {
    kernel,
    fs,
    /** Park the next reply of `name`; the returned wait resolves once something asked it. */
    hold(name) {
      holds.add(name);
      return async () => {
        for (let i = 0; i < 500 && !parked.some((p) => p.name === name); i++) await sleep(2);
        assert.ok(parked.some((p) => p.name === name), `a ${name} was asked`);
      };
    },
    release(name) { parked.splice(parked.findIndex((p) => p.name === name), 1)[0].release(); },
  };
}

/** What a call that cannot wait reads of `path`: its stat, null where nothing is, or 'EAGAIN' where the view cannot say (one listed on demand may refuse a name it does not know). */
function synchronously(fs, path) {
  try { return fs.synchronous.stat(path); }
  catch (error) { if (error?.code === 'EAGAIN') return 'EAGAIN'; throw error; }
}
function notServed(fs, path, what) {
  const seen = synchronously(fs, path);
  assert.ok(seen === null || seen === 'EAGAIN', `${what}: served ${JSON.stringify(seen)}`);
}

/** A barrier admits a peer's removal of `d/f` while `learning` (begun before the removal, `d` known) waits on its parked `reply`; then it lands. */
async function lateLearning(tree, reply, learning) {
  const s = await session(tree);
  assert.equal((await s.fs.stat(k('d'))).type, 'directory');
  const asked = s.hold(reply);
  const first = learning(s);
  await asked();
  await s.kernel.unlink(k('d/f'));
  s.fs.inbound();
  const barrier = s.fs.stat(k('other'));
  const landed = await Promise.race([barrier.then(() => true), sleep(1_000).then(() => false)]);
  s.release(reply);
  await first;
  await barrier;
  assert.ok(landed, 'the barrier landed while the learning waited on its reply');
  return s;
}

const scenarios = {
  async 'a late lookup reply never brings back a file a barrier saw removed'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', other: 'o' }, 'fsReadBatch', (s) => s.fs.stat(k('d/f')));
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
  },
  async 'a late listing never brings back a file a barrier saw removed'() {
    const s = await lateLearning({ d: null, 'd/f': 'f', 'd/g': 'g', other: 'o' }, 'fsReadBatch', (s) => s.fs.readdir(k('d')));
    notServed(s.fs, k('d/f'), 'what a call that cannot wait reads of the removed file');
    assert.equal(await s.fs.stat(k('d/f')), null, 'the removed file');
    assert.deepEqual((await s.fs.readdir(k('d'))).map((entry) => entry.name).sort(), ['g'], 'the directory');
  },
  async 'a learned name under a directory a peer made unsearchable is refused after the barrier'() {
    const s = await session({ d: null, 'd/f': 'f', other: 'o' });
    assert.notEqual(await s.fs.stat(k('d/f')), null);
    await s.kernel.chown(k('d'), 2000, 2000);
    await s.kernel.chmod(k('d'), 0o700);
    s.fs.inbound();
    await s.fs.stat(k('other'));
    await assert.rejects(async () => s.fs.stat(k('d/f')), (error) => error.code === 'EACCES');
  },
};
for (const kind of ENGINES) {
  scenarios[`a learned name under a directory a peer replaced is gone after the barrier [${kind}]`] = async () => {
    const engine = await bootEngine(kind, {
      seed: (authority) => {
        for (const dir of ['d', 'x']) authority.kfs.mkdir(`home/user/app/${dir}`, { mode: 0o755 });
        authority.kfs.writeFile('home/user/app/d/f', 'f');
        authority.kfs.writeFile('home/user/app/x/g', 'g');
      },
    });
    assert.notEqual(await engine.stat(`${APP}/d/f`), null);
    await engine.authority.peer.rename('home/user/app/d', 'home/user/app/d-old');
    await engine.authority.peer.rename('home/user/app/x', 'home/user/app/d');
    await engine.input();
    let seen;
    try { seen = engine.sync.stat(`${APP}/d/f`); } catch (error) { seen = error?.code; }
    assert.ok(seen === null || (kind === 'holder' && seen === 'EAGAIN'), `what a call that cannot wait reads of the old directory's file: ${JSON.stringify(seen)}`);
    assert.equal(await engine.stat(`${APP}/d/f`), null, 'the old directory\'s file, under the new one');
    assert.notEqual(await engine.stat(`${APP}/d/g`), null, 'the new directory\'s file');
  };
}

await runScenarios(import.meta.path, scenarios);
