#!/usr/bin/env bun
/**
 * resident-store-late-fill — bytes read before a change, whose answer lands
 * after a barrier admitted that change, are not installed.
 *
 * Read-ahead (and a syscall the watchdog gave up on) completes beside the
 * program's own calls: a barrier can admit a file's new revision while a
 * read of its old bytes is still in flight. A same-size rewrite would then be
 * served the old bytes, a read checking only their length.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();
const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const files = new ProcessFiles(new SqliteVFS(harness.sql, harness.ctx));
const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
const authority = files.bind({ pid: 2, cred: USER });
await kernel.mkdir('/home/user', { recursive: true });
await kernel.chown('/home/user', 1000, 1000);
await kernel.writeFile('/home/user/index', enc.encode('old!'));

const store = createResidentStore();
store.bindInMemory(16 * 1024 * 1024);
let gate = null;
const supervisor = {
  fsAcquire: (...args) => authority.acquire(...args),
  fsList: (...args) => authority.list(...args),
  readdir: (path) => authority.readdir(path),
  readlink: (path) => authority.readlink(path),
  stat: (path, options) => authority.stat(path, options),
  async fsReadBatch(requests) {
    // Read now; answer once the gate opens (the answer is late, the bytes are not).
    const out = [];
    let reads = false;
    for (const request of requests) {
      try {
        if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
        else { reads = true; out.push({ bytes: await authority.readRange(request.path, request.offset, request.length, { expectedEpoch: request.expectedEpoch, expectedRevision: request.expectedRevision }) }); }
      } catch (error) { out.push({ error }); }
    }
    if (reads && gate) await gate;
    return out;
  },
};
store.admission.setStorage(undefined, supervisor);
assert.equal(await store.view.bootLazy(supervisor), true);
const view = store.view.namespaceView(supervisor, (await authority.stat('/')).dev, USER);
try {
  assert.equal(await view.lookup(['home', 'home/user', 'home/user/index'], false), true);
  const before = view.entry('home/user/index');

  let open;
  gate = new Promise((resolve) => { open = resolve; });
  const late = view.fill('home/user/index', before);
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A same-size rewrite, and a barrier that admits it, while the old read is in flight.
  await kernel.writeFile('/home/user/index', enc.encode('new!'));
  assert.equal((await view.barrier()).landed, true);
  open();
  await late;
  gate = null;
  assert.equal(await view.lookup(['home/user/index'], false), true);
  const now = view.entry('home/user/index');
  assert.ok(now.revision > before.revision, 'the barrier admitted the rewrite');
  assert.equal(now.size, before.size, 'of the same size');
  assert.equal(view.content('home/user/index', now.revision), undefined, 'the old bytes are not served for the new revision');
  assert.equal(dec.decode(await view.fill('home/user/index', now)), 'new!', 'a fill at the new revision installs');
  assert.equal(dec.decode(view.content('home/user/index', now.revision)), 'new!');
} finally {
  harness.db.close();
}
console.log('resident-store-late-fill: a late answer older than the admitted revision is not installed');
