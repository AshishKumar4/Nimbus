#!/usr/bin/env bun
// A program that writes a tree synchronously parks every file, and the
// write-back carries them all to the authority at once. Unbounded, a
// 10-directory, 250-file seed issued ~250 concurrent writeFile RPCs; live,
// some never reached the session DO and never settled, so the process printed
// its last line and never exited. The write-back keeps at most 6 in flight,
// and every file still lands.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const dec = new TextDecoder();

const cwd = '/home/user/app';
vfs.mkdir(cwd, { recursive: true });

// The raw timer: the latency is the authority's, not a resumption of the program.
const rawSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((resolve) => rawSetTimeout(resolve, ms));
const slow = (fn) => async (...args) => { await wait(5); return fn(...args); };

let writesInFlight = 0;
let maxWritesInFlight = 0;
const supervisor = {
  readFile: slow(async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; }),
  writeFile: async (p, c) => {
    writesInFlight++;
    maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
    try { await wait(5); return bridge.writeFile(p, c); } finally { writesInFlight--; }
  },
  stat: slow((p) => bridge.stat(p)),
  lstat: slow((p) => bridge.stat(p, { followSymlinks: false })),
  readdir: slow((p) => bridge.readdir(p)),
  exists: slow(async (p) => (await bridge.stat(p)) !== null),
  mkdir: slow((p, o) => bridge.mkdir(p, o ?? { recursive: true })),
  fsReadRange: slow((p, o, l) => bridge.readRange(p, o, l)),
  fsAcquire: slow((epoch, cursor) => bridge.acquire(epoch, cursor)),
};

globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };
globalThis.__nimbusRawSetTimeout = rawSetTimeout;
globalThis.__nimbusRawClearTimeout = globalThis.clearTimeout;
globalThis.__nimbusProcessExitPromise = new Promise(() => {});

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() + '\n' + ENTRYPOINT_EVENT_LOOP
  + '\n;return { fs: __fsMod, runToExit: __nimbusRunEntrypointToExit, drain: __nimbusDrainVfsWrites };',
);
const { fs, runToExit, drain } = factory(
  {},
  { 'home/user/app': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {}, { 'home/user/app': [] }, supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, cwd, [], {}, `${cwd}/seed.js`, cwd,
);

const DIRS = 'abcdefghij'.split('');
const PER_DIR = 25;
for (const d of DIRS) {
  fs.mkdirSync(`${cwd}/seed/${d}`, { recursive: true });
  for (let i = 0; i < PER_DIR; i++) fs.writeFileSync(`${cwd}/seed/${d}/f${i}.txt`, `${d}${i}`);
}

const loop = await runToExit(undefined, 20_000);
await drain(supervisor);
assert.equal(loop.pending, 0, 'the loop must end because the work is done');
assert.ok(maxWritesInFlight <= 6, `at most 6 write-backs in flight (saw ${maxWritesInFlight})`);

for (const d of DIRS) {
  const names = (await bridge.readdir(`${cwd}/seed/${d}`)).map((e) => e.name);
  assert.equal(names.length, PER_DIR, `every file of ${d} reached the authority (got ${names.length})`);
}
assert.equal(dec.decode(await bridge.readFile(`${cwd}/seed/j/f24.txt`)), 'j24', 'with its bytes');

console.log('ok - facet-write-back-bounded');
