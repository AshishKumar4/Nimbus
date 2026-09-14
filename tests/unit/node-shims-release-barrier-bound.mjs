#!/usr/bin/env bun
// The RELEASE barrier ahead of egress must be BOUNDED.
//
// It was not, and it took `npx sv create` off main: RELEASE awaited
// `__nimbusDrainVfsWrites`, which ends with `while (pendingMutations > 0)`.
// That wait is right at process exit, where no new writes are coming, and is a
// livelock anywhere else — a facet unpacking a tarball adds mutations faster
// than the loop retires them. Sited ahead of egress it meant the request never
// left the facet: the program ran, printed, and never reported an exit.
//
// The shape the original fetch-coherence test missed is a facet that writes
// CONTINUOUSLY WHILE fetching. That is the only condition under which the
// quiesce loop never terminates, and it is what this test reproduces: writes
// keep landing for as long as the fetch is outstanding.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const dec = new TextDecoder();
const dir = '/home/user/t';
vfs.mkdir(dir, { recursive: true });

// The authority is a round trip away. Latency is what makes the starvation
// real: with an instant supervisor the drain always outpaces the writer, and
// the quiesce loop the old RELEASE rode on looks harmless. 20 ms spans the
// writer's 1 ms cadence twenty times over.
const rawSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((resolve) => rawSetTimeout(resolve, ms));
const LATENCY_MS = 20;
const slow = (fn) => async (...args) => { await wait(LATENCY_MS); return fn(...args); };

const supervisor = {
  readFile: slow(async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; }),
  writeFile: slow((p, c) => bridge.writeFile(p, c)),
  stat: slow((p) => bridge.stat(p)),
  lstat: slow((p) => bridge.stat(p, { followSymlinks: false })),
  readdir: slow((p) => bridge.readdir(p)),
  exists: slow(async (p) => (await bridge.stat(p)) !== null),
  access: slow((p, m) => bridge.access(p, m)),
  mkdir: slow((p) => bridge.mkdir(p, { recursive: true })),
  fsReadRange: slow((p, o, l) => bridge.readRange(p, o, l)),
  fsAcquire: slow((epoch, cursor) => bridge.acquire(epoch, cursor)),
};
globalThis.__nimbusRawClearTimeout = globalThis.clearTimeout;
globalThis.__nimbusProcessExitPromise = new Promise(() => {});

// The network stub does not resolve until the test lets it, so the facet is
// genuinely mid-fetch while it keeps writing — an unpack streaming to disk.
let releaseNetwork;
const networkReached = { yes: false };
globalThis.fetch = async () => {
  networkReached.yes = true;
  await new Promise((resolve) => { releaseNetwork = resolve; });
  return new Response('ok');
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod, fetch: globalThis.fetch };',
);
const out = factory(
  {},
  { 'home/user/t': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
  {},
  { 'home/user': ['t'], 'home/user/t': [] },
  supervisor,
  { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  dir, [], {}, `${dir}/s.mjs`, dir,
);
const { fs } = out;

// Writes are already parked when the request is issued, and more keep landing
// for as long as it is outstanding.
for (let i = 0; i < 40; i++) fs.writeFileSync(`${dir}/pre-${i}.txt`, `v${i}`);

let writing = true;
let written = 40;
// The writer's cadence must not pay the ACQUIRE barrier the shims wrap into
// setTimeout — that would slow it to the drain's pace and starve nothing.
// The deadline is raw for the same reason: it has to fire no matter what the
// barrier is doing.
const keepWriting = (async () => {
  while (writing) {
    fs.writeFileSync(`${dir}/stream-${written++}.txt`, 'x'.repeat(64));
    await wait(1);
  }
})();

const deadline = new Promise((_, reject) => {
  rawSetTimeout(() => reject(new Error(
    'the request never left the facet: RELEASE waited on a condition a writing process never reaches',
  )), 5_000);
});

// The barrier may delay the request. It may not prevent it.
const pending = out.fetch('https://registry.invalid/pkg.tgz');
await Promise.race([
  (async () => { while (!networkReached.yes) await wait(5); })(),
  deadline,
]);

assert.ok(networkReached.yes, 'the request reached the network while the facet was still writing');
assert.ok(written > 40, 'the facet really was writing continuously across the barrier');

releaseNetwork();
const response = await pending;
assert.equal(response.status, 200, 'and the caller still gets its response');

writing = false;
await keepWriting;

// RELEASE is a barrier, not a best-effort: everything parked when the request
// was issued must be at the authority, or an outside observer could act on an
// effect of a write the authority does not have.
const settle = async () => {
  for (let i = 0; i < 40; i++) {
    if (await bridge.readFile(`${dir}/pre-39.txt`) !== null) return;
    await wait(25);
  }
};
await settle();
assert.equal(
  dec.decode(await bridge.readFile(`${dir}/pre-39.txt`)),
  'v39',
  'the writes parked when the request was issued reached the authority',
);

console.log(`node-shims-release-barrier-bound: all assertions passed (${written} writes across the barrier)`);
