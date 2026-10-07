#!/usr/bin/env bun
// A successful response from a resident Node server is a durability boundary:
// file content written synchronously via writeFileSync by the request handler must
// already be visible through the supervisor VFS when the response is returned.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createFacetWorld, createFacetCtx, createProcessFacetCtx } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { waveSupervisor } from './lib/wave-supervisor.mjs';

/** One storage slot per constructed process: these cases are independent. */
let facetSeq = 0;

let supervisorFactory = () => ({});
// Every facet lists its namespace before its program runs: the session's own
// listing and delta ops back whatever a case's supervisor does not define.
let listingOps = null;
adoptCtxExports({ SupervisorRPC: (...args) => asLaunchSupervisor(supervisorFactory(...args)) });

// The spawn goes through the real fabric: the facet's module map is assembled
// in the loader's cache-miss callback, which is where the generated worker's
// image is read back off the session disk. This test then exercises that
// generated source directly.
const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() {
    throw new Error('the generated worker is exercised directly in this test');
  },
}));

const env = {
  LOADER: world.loader,
  ASSETS: stagedAssets,
};
const ctx = createFacetCtx(world, 'request-durability-test');
const processes = new SessionProcessSupervisor();
const ports = new PortRegistry();
const manager = new FacetManager(ctx, env, processes, ports, processHostFor, {});
// The spawn materializes its generated module map in the session's image store
// and boots from the path, so the manager needs a real disk.
const harness = createSqliteVfsTestHarness();
const sessionVfs = new SqliteVFS(harness.sql, harness.ctx);
{
  const kernel = sessionVfs.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
}
manager.setVfs(sessionVfs, processFiles(sessionVfs));
{
  const host = attachSupervisorOps({ sqliteFs: sessionVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });
  listingOps = {
    fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null),
    fsReadBatch: (requests) => _rpcFsReadBatch(host, requests),
    fsAcquire: (epoch, cursor, options) => _rpcFsAcquire(host, epoch, cursor, options),
  };
}
/** The generated worker source the facet actually booted from. */
const residentWorkerSource = () => world.boots.at(-1).config.modules['worker.js'];
const residentModules = () => world.boots.at(-1).config.modules;
const cellText = (content) => content instanceof Uint8Array
  ? new TextDecoder().decode(content)
  : String(content);

const userCode = `
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  const content = req.url === '/race' ? 'older'
    : req.url === '/same-race' ? 'same'
    : req.url.slice(1);
  fs.writeFileSync('/home/user/request-result.txt', content);
  if (req.url === '/sync-append' || req.url === '/sync-appends') {
    fs.appendFileSync('/home/user/live-prefix.txt', 'A');
    if (req.url === '/sync-appends') {
      fs.appendFileSync('/home/user/live-prefix.txt', 'B');
    }
  }
  if (req.url === '/pending-drain') {
    console.log('blocked prior output');
  }
  if (req.url === '/codegen') {
    // Code produced while serving: staged for the next launch and reported.
    try { globalThis.__nimbusRuntimeCode.compileFunction('async', [], 'return 1'); } catch {}
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: live\\n\\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
  if (req.url === '/race' || req.url === '/same-race') {
    // A newer write from a timer, once the case says the older write's RPC
    // is in flight (globalThis.__raceHooks); it tells the case when written.
    const next = req.url === '/race' ? 'newer' : 'same';
    const { started, written } = globalThis.__raceHooks;
    started.then(() => setTimeout(() => { fs.writeFileSync('/home/user/request-result.txt', next); written(); }, 0));
  }
}).listen(4387);
`;

await manager.spawnNode(userCode, {
  command: 'node --watch server.js',
  filename: '/home/user/server.js',
  cwd: '/home/user',
  port: 4387,
});
assert.equal(world.boots.length, 1, 'the spawn evaluated the generated worker exactly once');
assert.ok(residentWorkerSource().includes('NimbusProcess'), 'the facet booted the generated worker');

/**
 * A launched facet's SUPERVISOR: the case's stub, over the session's listing
 * and delta ops for anything it does not define, since a facet lists its
 * namespace before its program runs. (A shims-only factory has its own
 * authority, and never gets these.)
 */
function asLaunchSupervisor(supervisor) {
  if (listingOps) for (const [name, op] of Object.entries(listingOps)) if (!(name in supervisor)) supervisor[name] = op;
  // Its process's waves reach the supervisor's own calls (lib/wave-supervisor.mjs).
  return waveSupervisor(supervisor);
}

function makeShimFsFacet(supervisor, bundle = {}) {
  waveSupervisor(supervisor);
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    `"use strict";${VFS_WRITE_LEDGER_SOURCE}\n${SHIMS_STORE_PRELUDE + generateShimsCode()}
;return {
  fs: builtins.fs,
  writes: __vfsWrites,
  queueVfsMutation: __nimbusQueueVfsMutation,
  drainVfsMutations: __nimbusDrainVfsMutations,
  flushVfsWrite: __nimbusFlushVfsWrite,
  drainVfsWrites: __nimbusDrainVfsWrites,
};`,
  );
  // Staged content comes with its records, as every launch stages it
  // the process's own home and files.
  const metadata = { 'home/user': { type: 'directory', size: 0, mode: 0o40755, uid: 1000, gid: 1000 } };
  for (const [path, cell] of Object.entries(bundle)) {
    metadata[path] = { type: 'file', size: typeof cell === 'string' ? new TextEncoder().encode(cell).length : cell.length, mode: 0o100644, uid: 1000, gid: 1000 };
  }
  return (declareNamespace({ metadata: metadata, manifest: {} }), factory(
    bundle,
    {},
    supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user',
    [],
    {},
    '/home/user/main.mjs',
    '/home/user',
  ));
}

async function assertAsyncFlushPreservesNewerWrite(initial, newer) {
  let releaseWrite;
  let writeStarted;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const persisted = [];
  const supervisor = {
    async writeFile(_path, content) {
      persisted.push(content instanceof Uint8Array ? new TextDecoder().decode(content) : String(content));
      if (persisted.length === 1) {
        writeStarted();
        await writeGate;
      }
    },
    async fsTruncate() {},
  };
  const { fs } = makeShimFsFacet(supervisor);
  const path = '/home/user/flush-race.txt';
  fs.writeFileSync(path, initial);
  const flushing = fs.promises.truncate(path, String(initial).length);
  await started;
  fs.writeFileSync(path, newer);
  releaseWrite();
  await flushing;
  await fs.promises.truncate(path, String(newer).length);
  assert.equal(
    fs.readFileSync(path, 'utf8'),
    newer,
    'an async helper flush clears only the mutation generation it persisted',
  );
  assert.deepEqual(
    persisted,
    [initial, newer],
    'the next helper boundary persists the newer pending cell',
  );
}

await assertAsyncFlushPreservesNewerWrite('older', 'newer');
await assertAsyncFlushPreservesNewerWrite('same', 'same');

// Shim-triggered flushes and request-boundary full writes share one per-path
// queue, so a delayed older authority RPC cannot land after the newer content.
{
  let releaseOlder;
  let olderStarted;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  const olderCall = new Promise((resolve) => { olderStarted = resolve; });
  const durable = new Map();
  const calls = [];
  const supervisor = {
    async writeFile(path, content) {
      const text = cellText(content);
      calls.push(text);
      if (text === 'older') {
        olderStarted();
        await olderGate;
      }
      durable.set(path.replace(/^\/+/, ''), text);
    },
    async fsTruncate() {},
  };
  const { fs, flushVfsWrite } = makeShimFsFacet(supervisor);
  const path = '/home/user/cross-boundary-race.txt';
  fs.writeFileSync(path, 'older');
  const shimFlush = fs.promises.truncate(path, 5);
  await olderCall;
  fs.writeFileSync(path, 'newer');
  const boundaryFlush = flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  await Promise.resolve();
  assert.deepEqual(calls, ['older'], 'same-path boundary write waits behind the older shim flush');
  releaseOlder();
  await Promise.all([shimFlush, boundaryFlush]);
  assert.equal(durable.get('home/user/cross-boundary-race.txt'), 'newer');
  assert.deepEqual(calls, ['older', 'newer']);
}

// An older fs.promises.writeFile completion clears only its own captured
// generation. A newer writeFileSync cell remains pending and can be persisted.
{
  let releaseOlder;
  let olderStarted;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  const olderCall = new Promise((resolve) => { olderStarted = resolve; });
  const durable = new Map();
  const calls = [];
  const supervisor = {
    async writeFile(path, content) {
      const text = cellText(content);
      calls.push(text);
      if (text === 'older') {
        olderStarted();
        await olderGate;
      }
      durable.set(path, text);
    },
  };
  const { fs, flushVfsWrite } = makeShimFsFacet(supervisor);
  const path = '/home/user/async-write-race.txt';
  const older = fs.promises.writeFile(path, 'older');
  await olderCall;
  fs.writeFileSync(path, 'newer');
  releaseOlder();
  await older;
  await flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  assert.equal(durable.get(path), 'newer');
  assert.deepEqual(calls, ['older', 'newer']);
}

// An append and the full write after it reach the authority in the order they
// were made (the process's one log), whatever the first's latency.
{
  let releaseAppend;
  let appendStarted;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const appendCall = new Promise((resolve) => { appendStarted = resolve; });
  let durable = 'base';
  const completions = [];
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      appendStarted();
      await appendGate;
      durable = durable.slice(0, position) + new TextDecoder().decode(bytes);
      completions.push('append');
    },
    async writeFile(_path, content) {
      durable = cellText(content);
      completions.push('full');
    },
  };
  const { fs } = makeShimFsFacet(supervisor);
  const path = '/home/user/append-order.txt';
  const append = fs.promises.appendFile(path, 'A');
  await appendCall;
  const full = fs.promises.writeFile(path, 'newer');
  releaseAppend();
  await Promise.all([append, full]);
  assert.equal(durable, 'newer');
  assert.deepEqual(completions, ['append', 'full']);
}

// A full write queued before an append remains a full image; the later append
// extends that image rather than reviving the external prefix it replaced.
{
  let releaseFull;
  let fullStarted;
  const fullGate = new Promise((resolve) => { releaseFull = resolve; });
  const fullCall = new Promise((resolve) => { fullStarted = resolve; });
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      const suffix = new TextDecoder().decode(bytes);
      calls.push(`range:${suffix}`);
      durable = durable.slice(0, position) + suffix;
    },
    async writeFile(_path, content) {
      const text = cellText(content);
      calls.push(`full:${text}`);
      if (text === 'new') {
        fullStarted();
        await fullGate;
      }
      durable = text;
    },
  };
  const { fs } = makeShimFsFacet(supervisor);
  const path = '/home/user/full-then-append.txt';
  const full = fs.promises.writeFile(path, 'new');
  await fullCall;
  const append = fs.promises.appendFile(path, 'A');
  releaseFull();
  await Promise.all([full, append]);
  assert.equal(durable, 'newA');
  // The append extends what the write made, at the authority's end.
  assert.deepEqual(calls, ['full:new', 'range:A']);
}

// Concurrent appends to a live-only file carry only their uncommitted suffix
// through the per-path queue. The local fragment must never replace the live
// prefix as if it were a complete file image.
{
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstCall = new Promise((resolve) => { firstStarted = resolve; });
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      const suffix = new TextDecoder().decode(bytes);
      calls.push(`range:${suffix}`);
      if (suffix === 'A') {
        firstStarted();
        await firstGate;
      }
      durable = durable.slice(0, position) + suffix;
    },
    async writeFile(_path, content) {
      const text = cellText(content);
      calls.push(`full:${text}`);
      durable = text;
    },
  };
  const { fs, writes } = makeShimFsFacet(supervisor);
  const path = '/home/user/concurrent-appends.txt';
  const first = fs.promises.appendFile(path, 'A');
  await firstCall;
  const second = fs.promises.appendFile(path, 'B');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(durable, 'baseAB');
  assert.deepEqual(calls, ['range:A', 'range:B']);
  assert.equal(Object.prototype.hasOwnProperty.call(writes, 'home/user/concurrent-appends.txt'), false);
}

// The request boundary can await every queued file-content mutation, including
// operations that do not create a whole-file __vfsWrites cell.
{
  let releaseMutation;
  const gate = new Promise((resolve) => { releaseMutation = resolve; });
  const facet = makeShimFsFacet({});
  const mutation = facet.queueVfsMutation(
    '/home/user/queued-range.txt',
    () => gate,
  );
  let drained = false;
  const drain = facet.drainVfsMutations().then(() => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(drained, false);
  releaseMutation();
  await Promise.all([mutation, drain]);
  assert.equal(drained, true);
}

// A failed mutation remains visible to the next durability boundary even when
// the caller observed/caught it before the boundary started. The failure is
// consumed exactly once so it cannot poison unrelated later requests.
{
  const facet = makeShimFsFacet({});
  await assert.rejects(
    facet.queueVfsMutation(
      '/home/user/settled-failure.txt',
      async () => { throw new Error('settled before boundary'); },
    ),
    /settled before boundary/,
  );
  await assert.rejects(
    facet.drainVfsMutations(),
    /settled before boundary/,
  );
  await facet.drainVfsMutations();
}

// A FileHandle range that first flushes a pending full image and a concurrent
// boundary capture of that same generation share one in-flight full-write
// claim. The boundary cannot queue a duplicate full image behind the range.
{
  let releaseFull;
  let fullStarted;
  const fullGate = new Promise((resolve) => { releaseFull = resolve; });
  const fullCall = new Promise((resolve) => { fullStarted = resolve; });
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async writeFile(_path, content) {
      const text = cellText(content);
      calls.push(`full:${text}`);
      fullStarted();
      await fullGate;
      durable = text;
    },
    async fsWriteRange(_path, position, bytes) {
      const text = new TextDecoder().decode(bytes);
      calls.push(`range:${text}`);
      durable = durable.slice(0, position) + text + durable.slice(position + bytes.byteLength);
    },
  };
  const { fs, flushVfsWrite, writes } = makeShimFsFacet(
    supervisor,
    { 'home/user/same-generation-claim.txt': 'base' },
  );
  const path = '/home/user/same-generation-claim.txt';
  const handle = await fs.promises.open(path, 'r+');
  fs.writeFileSync(path, 'newbase');
  const ranged = handle.write('X', 0);
  await fullCall;
  const boundary = flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  releaseFull();
  await Promise.all([ranged, boundary]);
  assert.equal(durable, 'Xewbase');
  assert.deepEqual(calls, ['full:newbase', 'range:X']);
  assert.equal(fs.readFileSync(path, 'utf8'), 'Xewbase');
  assert.equal(Object.prototype.hasOwnProperty.call(
    writes,
    'home/user/same-generation-claim.txt',
  ), false);
  await handle.close();
}

// A zero-byte positional FileHandle write is a true no-op: it neither extends
// the authority/local overlay nor advances the sequential handle position.
{
  let durable = 'base';
  let rangedWrites = 0;
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      rangedWrites++;
      const text = new TextDecoder().decode(bytes);
      durable = durable.slice(0, position) + text + durable.slice(position + bytes.byteLength);
    },
    async writeFile(_path, content) { durable = cellText(content); },
  };
  const { fs } = makeShimFsFacet(
    supervisor,
    { 'home/user/zero-byte-write.txt': 'base' },
  );
  const handle = await fs.promises.open('/home/user/zero-byte-write.txt', 'r+');
  const empty = new Uint8Array(0);
  const result = await handle.write(empty, 0, 0, 10);
  assert.equal(result.bytesWritten, 0);
  assert.equal(rangedWrites, 0);
  assert.equal(durable, 'base');
  assert.equal(fs.readFileSync('/home/user/zero-byte-write.txt', 'utf8'), 'base');
  const one = new Uint8Array(1);
  const read = await handle.read(one, 0, 1, null);
  assert.equal(read.bytesRead, 1);
  assert.equal(new TextDecoder().decode(one), 'b');
  await handle.close();
}

// FileHandle ranged writes participate in the same authority queue as a later
// synchronous full cell, and a delayed range completion cannot overlay that
// newer local generation.
{
  let releaseRange;
  let rangeStarted;
  const rangeGate = new Promise((resolve) => { releaseRange = resolve; });
  const rangeCall = new Promise((resolve) => { rangeStarted = resolve; });
  let durable = 'base';
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      rangeStarted();
      await rangeGate;
      const text = new TextDecoder().decode(bytes);
      durable = durable.slice(0, position) + text + durable.slice(position + bytes.byteLength);
    },
    async writeFile(_path, content) { durable = cellText(content); },
  };
  const { fs, flushVfsWrite, writes } = makeShimFsFacet(supervisor);
  const path = '/home/user/handle-range-race.txt';
  const handle = await fs.promises.open(path, 'r+');
  const ranged = handle.write('OLD', 0);
  await rangeCall;
  fs.writeFileSync(path, 'newer');
  const boundary = flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  await Promise.resolve();
  releaseRange();
  await Promise.all([ranged, boundary]);
  assert.equal(durable, 'newer');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  assert.equal(Object.prototype.hasOwnProperty.call(writes, 'home/user/handle-range-race.txt'), false);
  await handle.close();
}

// The local-generation guard is captured when FileHandle.write is scheduled,
// not when a preceding same-path mutation finally lets its queue callback run.
{
  let releaseBlocker;
  let blockerStarted;
  const blockerGate = new Promise((resolve) => { releaseBlocker = resolve; });
  const blockerCall = new Promise((resolve) => { blockerStarted = resolve; });
  let durable = 'base';
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      const text = new TextDecoder().decode(bytes);
      if (text === 'X') {
        blockerStarted();
        await blockerGate;
      }
      durable = durable.slice(0, position) + text + durable.slice(position + bytes.byteLength);
    },
    async writeFile(_path, content) { durable = cellText(content); },
  };
  const { fs, flushVfsWrite } = makeShimFsFacet(supervisor);
  const path = '/home/user/queued-handle-range-race.txt';
  const handle = await fs.promises.open(path, 'r+');
  const blocker = handle.write('X', 0);
  await blockerCall;
  const ranged = handle.write('OLD', 0);
  fs.writeFileSync(path, 'newer');
  const boundary = flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  releaseBlocker();
  await Promise.all([blocker, ranged, boundary]);
  assert.equal(durable, 'newer');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  await handle.close();
}

// Concurrent append-mode FileHandle writes resolve the live EOF inside their
// shared queue, so the second range cannot reuse the first range's old offset.
{
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstCall = new Promise((resolve) => { firstStarted = resolve; });
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat() { return { type: 'file', size: durable.length }; },
    async fsWriteRange(_path, position, bytes) {
      const suffix = new TextDecoder().decode(bytes);
      calls.push([position, suffix]);
      if (suffix === 'A') {
        firstStarted();
        await firstGate;
      }
      durable = durable.slice(0, position) + suffix;
    },
    async writeFile(_path, content) { durable = cellText(content); },
  };
  const { fs } = makeShimFsFacet(supervisor);
  const handle = await fs.promises.open('/home/user/handle-appends.txt', 'a');
  const first = handle.write('A');
  await firstCall;
  const second = handle.write('B');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(durable, 'baseAB');
  assert.deepEqual(calls, [[4, 'A'], [5, 'B']]);
  await handle.close();
}

// Live truncation is ordered with later full content and its post-RPC local
// update is generation-guarded just like ranged writes.
{
  let releaseTruncate;
  let truncateStarted;
  const truncateGate = new Promise((resolve) => { releaseTruncate = resolve; });
  const truncateCall = new Promise((resolve) => { truncateStarted = resolve; });
  let durable = 'abcdef';
  // Revisions as the session's authority dates them: each mutation answers
  // with the receipt a real one does.
  let rev = 1;
  const supervisor = {
    async fsTruncate(_path, size) {
      truncateStarted();
      await truncateGate;
      durable = durable.slice(0, size);
      const before = rev; rev += 1;
      return { before, after: rev };
    },
    async writeFile(_path, content) { durable = cellText(content); rev += 1; return rev; },
  };
  const path = '/home/user/truncate-race.txt';
  const { fs, flushVfsWrite, writes } = makeShimFsFacet(
    supervisor,
    { 'home/user/truncate-race.txt': 'abcdef' },
  );
  const truncating = fs.promises.truncate(path, 3);
  await truncateCall;
  fs.writeFileSync(path, 'newer');
  const boundary = flushVfsWrite(path, (content) => supervisor.writeFile(path, content));
  releaseTruncate();
  await Promise.all([truncating, boundary]);
  assert.equal(durable, 'newer');
  assert.equal(fs.readFileSync(path, 'utf8'), 'newer');
  assert.equal(Object.prototype.hasOwnProperty.call(writes, 'home/user/truncate-race.txt'), false);
}

// A refused write rejects its caller and leaves nothing of it parked; the
// path's next write is sent and lands.
{
  let refuse = true;
  let durable;
  const supervisor = {
    async writeFile(_path, content) {
      if (refuse) throw Object.assign(new Error('EACCES: injected refusal'), { code: 'EACCES' });
      durable = cellText(content);
    },
  };
  const { fs, writes } = makeShimFsFacet(supervisor);
  const path = '/home/user/retry-after-failure.txt';
  await assert.rejects(fs.promises.writeFile(path, 'failed'), (error) => error.code === 'EACCES');
  assert.equal(Object.prototype.hasOwnProperty.call(writes, 'home/user/retry-after-failure.txt'), false, 'a refused write stayed parked');
  refuse = false;
  await fs.promises.writeFile(path, 'recovered');
  assert.equal(durable, 'recovered');
  assert.equal(Object.prototype.hasOwnProperty.call(writes, 'home/user/retry-after-failure.txt'), false);
}

async function loadGeneratedWorker() {
  const source = residentWorkerSource() + `
export function __nimbusTestPendingIOLength() {
  return __nimbusRuntime ? __nimbusRuntime.pendingIO.length : -1;
}
export function __nimbusTestRuntimeState() {
  return __nimbusRuntime
    ? { pendingIOLength: __nimbusRuntime.pendingIO.length, settledIO: __nimbusRuntime.settledIO }
    : null;
}`;
  return importModuleSet({ ...residentModules(), 'worker.js': source }, 'worker.js');
}

function request(path = 'first') {
  return new Request(`http://127.0.0.1:4387/${path}`, {
    headers: { 'X-Nimbus-Port': '4387' },
  });
}

// The public generated entrypoint must not return a successful response until
// its handler's pending writeFileSync content has crossed the supervisor boundary.
{
  delete globalThis.__portRegistry;
  const durable = new Map();
  const writes = [];
  const supervisor = {
    async writeFile(path, content) {
      writes.push([path.replace(/^\/+/, ''), cellText(content)]);
      durable.set(path.replace(/^\/+/, ''), cellText(content));
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );

  const response = await worker.handleHttpRequest(request());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok:/first');
  assert.equal(
    durable.get('home/user/request-result.txt'),
    'first',
    'request-time writeFileSync content is durable before the 200 response returns',
  );

  const second = await worker.handleHttpRequest(request('second'));
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'ok:/second');
  assert.deepEqual(
    writes.map(([, content]) => content),
    ['first', 'second'],
    'a successfully flushed cell is removed instead of being rewritten at the next request',
  );
}

// appendFileSync on a nonresident live file records append-only content, so the
// request boundary appends at authority EOF instead of replacing its prefix.
{
  delete globalThis.__portRegistry;
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat(path) {
      return path.replace(/^\/+/, '') === 'home/user/live-prefix.txt'
        ? { type: 'file', size: durable.length }
        : null;
    },
    async fsWriteRange(_path, position, bytes) {
      const suffix = new TextDecoder().decode(bytes);
      calls.push(`range:${suffix}`);
      durable = durable.slice(0, position) + suffix;
    },
    async writeFile(path, content) {
      if (path.replace(/^\/+/, '') === 'home/user/live-prefix.txt') {
        const text = cellText(content);
        calls.push(`full:${text}`);
        durable = text;
      }
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  const response = await worker.handleHttpRequest(request('sync-append'));
  assert.equal(response.status, 200);
  assert.equal(durable, 'baseA');
  assert.deepEqual(calls, ['range:A']);
}

// Multiple unclaimed synchronous append fragments coalesce into one EOF
// mutation rather than one full image or duplicate range operations.
{
  delete globalThis.__portRegistry;
  let durable = 'base';
  const calls = [];
  const supervisor = {
    async stat(path) {
      return path.replace(/^\/+/, '') === 'home/user/live-prefix.txt'
        ? { type: 'file', size: durable.length }
        : null;
    },
    async fsWriteRange(_path, position, bytes) {
      const suffix = new TextDecoder().decode(bytes);
      calls.push(`range:${suffix}`);
      durable = durable.slice(0, position) + suffix;
    },
    async writeFile() {},
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  const response = await worker.handleHttpRequest(request('sync-appends'));
  assert.equal(response.status, 200);
  assert.equal(durable, 'baseAB');
  assert.deepEqual(calls, ['range:AB']);
}

// Repeated request-boundary content writes are awaited directly and do not
// accumulate settled promises in the resident runtime's pending-I/O array.
{
  delete globalThis.__portRegistry;
  const supervisor = {
    async writeFile() {},
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  for (let index = 0; index < 32; index++) {
    const response = await worker.handleHttpRequest(request(`retention-${index}`));
    assert.equal(response.status, 200);
  }
  assert.equal(
    generated.__nimbusTestPendingIOLength(),
    0,
    'settled request-boundary file-content writes are not retained',
  );
}

// Concurrent flush callers share one pending-I/O drain owner: neither request
// may complete while a prior stdout task claimed by the first drain is blocked.
{
  delete globalThis.__portRegistry;
  let releaseOutput;
  let outputStarted;
  const outputGate = new Promise((resolve) => { releaseOutput = resolve; });
  const started = new Promise((resolve) => { outputStarted = resolve; });
  const supervisor = {
    async writeFile() {},
    async registerPort() {},
    async unregisterPort() {},
    // The relay carries bytes; a stub that inspects the payload decodes it.
    async stdout(bytes) {
      if (cellText(bytes).includes('blocked prior output')) {
        outputStarted();
        await outputGate;
      }
    },
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  const first = worker.handleHttpRequest(request('pending-drain'));
  await started;
  const rawSetTimeout = globalThis.__nimbusRawSetTimeout || setTimeout;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (generated.__nimbusTestRuntimeState()?.settledIO === 1) break;
    await new Promise((resolve) => rawSetTimeout(resolve, 0));
  }
  assert.equal(generated.__nimbusTestRuntimeState()?.settledIO, 1, 'first flush claimed prior output');

  let secondCompleted = false;
  const second = worker.handleHttpRequest(request('concurrent-drain')).then((response) => {
    secondCompleted = true;
    return response;
  });
  await new Promise((resolve) => rawSetTimeout(resolve, 10));
  assert.equal(secondCompleted, false, 'second flush cannot skip work claimed by the first drain');

  releaseOutput();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(
    generated.__nimbusTestRuntimeState(),
    { pendingIOLength: 0, settledIO: 0 },
    'completed drain work is compacted after both callers finish',
  );
}

// Adding the durability boundary must not buffer an open response body.
{
  delete globalThis.__portRegistry;
  const durable = new Map();
  const supervisor = {
    async writeFile(path, content) { durable.set(path.replace(/^\/+/, ''), cellText(content)); },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  // Measure response streaming after boot, not against the separate 1 s
  // resident-startup settlement budget (which native HTTP may use).
  await worker.startProcess();
  const rawSetTimeout = globalThis.__nimbusRawSetTimeout || setTimeout;

  const response = await Promise.race([
    worker.handleHttpRequest(request('stream')),
    new Promise((_, reject) => rawSetTimeout(() => reject(new Error('stream response was buffered')), 1000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(durable.get('home/user/request-result.txt'), 'stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: live\n\n');
  await reader.cancel();
}

// If a newer local write lands while an older RPC is in flight, only the
// flushed cell is cleared; the newer bytes survive for the next boundary.
{
  delete globalThis.__portRegistry;
  let releaseOlder;
  let olderStarted;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  const olderCall = new Promise((resolve) => { olderStarted = resolve; });
  const writes = [];
  const supervisor = {
    async writeFile(_path, content) {
      const text = cellText(content);
      writes.push(text);
      if (text === 'older') {
        olderStarted();
        await olderGate;
      }
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );

  // The program's newer write lands while the older RPC is in flight: it
  // waits for that RPC to start, and the case for the write. One timer turn
  // after the start stood in for both before; under contention the
  // program's timer ran before the response's flush began, which then sent
  // 'newer' alone, and the older RPC this case waits on never came (a hang,
  // 3 in 96 runs eight at a time).
  let newerWritten;
  const newerWrite = new Promise((resolve) => { newerWritten = resolve; });
  globalThis.__raceHooks = { started: olderCall, written: newerWritten };
  const raced = worker.handleHttpRequest(request('race'));
  await olderCall;
  await newerWrite;
  releaseOlder();
  assert.equal((await raced).status, 200);
  delete globalThis.__raceHooks;

  const next = await worker.handleHttpRequest(request('after-race'));
  assert.equal(next.status, 200);
  assert.deepEqual(
    writes,
    ['older', 'newer', 'after-race'],
    'a newer local cell is preserved and flushed before the following handler',
  );
}

// Cell identity cannot be inferred from value equality: two separate writes of
// the same string still have distinct mutation generations.
{
  delete globalThis.__portRegistry;
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstCall = new Promise((resolve) => { firstStarted = resolve; });
  const writes = [];
  let sameCalls = 0;
  const supervisor = {
    async writeFile(_path, content) {
      const text = cellText(content);
      writes.push(text);
      if (text === 'same' && sameCalls++ === 0) {
        firstStarted();
        await firstGate;
      }
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );

  // As above: the second 'same' is written while the first one's RPC is in
  // flight (before, a timer turn stood in, and the second write could land
  // before the flush: ['same', 'after-same-race'], 1 in 96).
  let secondWritten;
  const secondWrite = new Promise((resolve) => { secondWritten = resolve; });
  globalThis.__raceHooks = { started: firstCall, written: secondWritten };
  const raced = worker.handleHttpRequest(request('same-race'));
  await firstCall;
  await secondWrite;
  releaseFirst();
  assert.equal((await raced).status, 200);
  delete globalThis.__raceHooks;

  const next = await worker.handleHttpRequest(request('after-same-race'));
  assert.equal(next.status, 200);
  assert.deepEqual(
    writes,
    ['same', 'same', 'after-same-race'],
    'a newer identical string cell survives the older write RPC',
  );
}

// A VFS failure cannot be hidden behind a successful HTTP response.
{
  delete globalThis.__portRegistry;
  const supervisor = {
    async writeFile() { throw new Error('injected durable write failure'); },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );

  await assert.rejects(
    () => worker.handleHttpRequest(request('failure')),
    /injected durable write failure/,
    'durability failure rejects the request instead of returning 200',
  );
}

// A failed report of generated code neither fails the response nor skips the
// request's writes; it is told to the process's stderr.
{
  delete globalThis.__portRegistry;
  const durable = new Map();
  const stderr = [];
  const supervisor = {
    async writeFile(path, content) { durable.set(path.replace(/^\/+/, ''), cellText(content)); },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr(bytes) { stderr.push(new TextDecoder().decode(bytes)); },
    async reportExit() {},
    async reportRuntimeCode() { throw new Error('Runtime code report has no live launch'); },
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  const response = await worker.handleHttpRequest(request('codegen'));
  assert.equal(response.status, 200, 'a failed code report does not fail the response');
  assert.equal(await response.text(), 'ok:/codegen');
  assert.equal(durable.get('home/user/request-result.txt'), 'codegen', 'and the request\'s write is durable');
  assert.ok(
    stderr.some((text) => text.includes('runtime code persistence failed: Runtime code report has no live launch')),
    `the failure reaches the process's stderr: ${JSON.stringify(stderr)}`,
  );
}

// Clean FileHandle range writes and truncates have no whole-file pending cell,
// but a response still cannot cross the durability boundary while either
// authority mutation is in flight.
{
  const port = 4390;
  await manager.spawnNode(`
const fs = require('node:fs');
const http = require('node:http');
let rangeHandle;
fs.promises.open('/home/user/clean-range.txt', 'w+').then((handle) => {
  rangeHandle = handle;
});
fs.promises.writeFile('/home/user/clean-truncate.txt', 'abcdef');
http.createServer((req, res) => {
  if (req.url === '/range') {
    void rangeHandle.write('R', 0, 1, 0);
  } else {
    void fs.promises.truncate('/home/user/clean-truncate.txt', 2).catch(() => {});
  }
  if (req.url === '/truncate-immediate') {
    setTimeout(() => res.end('ok'), 0);
    return;
  }
  res.end('ok');
}).listen(${port});
`, {
    command: 'node --watch clean-mutations.js',
    filename: '/home/user/clean-mutations.js',
    cwd: '/home/user',
    port,
  });

  delete globalThis.__portRegistry;
  const files = new Map();
  let releaseRange;
  let rangeStarted;
  const rangeGate = new Promise((resolve) => { releaseRange = resolve; });
  const rangeCall = new Promise((resolve) => { rangeStarted = resolve; });
  let releaseTruncate;
  let truncateStarted;
  let failTruncate = false;
  const truncateGate = new Promise((resolve) => { releaseTruncate = resolve; });
  const truncateCall = new Promise((resolve) => { truncateStarted = resolve; });
  const supervisor = {
    async stat(path) {
      const content = files.get(path);
      return content === undefined ? null : { type: 'file', size: content.byteLength };
    },
    async writeFile(path, content) {
      files.set(path, content instanceof Uint8Array
        ? content.slice()
        : new TextEncoder().encode(String(content)));
    },
    async fsWriteRange(path, position, bytes) {
      rangeStarted();
      await rangeGate;
      const current = files.get(path) || new Uint8Array(0);
      const next = new Uint8Array(Math.max(current.byteLength, position + bytes.byteLength));
      next.set(current);
      next.set(bytes, position);
      files.set(path, next);
    },
    async fsTruncate(path, size) {
      truncateStarted();
      await truncateGate;
      if (failTruncate) throw new Error('injected clean truncate failure');
      files.set(path, (files.get(path) || new Uint8Array(0)).slice(0, size));
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    { SUPERVISOR: asLaunchSupervisor(supervisor) },
  );
  const mutationRequest = (path) => new Request(`http://127.0.0.1:${port}/${path}`, {
    headers: { 'X-Nimbus-Port': String(port) },
  });

  let rangeReturned = false;
  const rangeResponse = worker.handleHttpRequest(mutationRequest('range')).then((response) => {
    rangeReturned = true;
    return response;
  });
  await rangeCall;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rangeReturned, false);
  releaseRange();
  assert.equal((await rangeResponse).status, 200);
  assert.equal(new TextDecoder().decode(files.get('/home/user/clean-range.txt')), 'R');

  failTruncate = true;
  const truncateResponse = worker.handleHttpRequest(mutationRequest('truncate'));
  await truncateCall;
  releaseTruncate();
  await assert.rejects(
    truncateResponse,
    /injected clean truncate failure/,
    'a floated clean mutation failure rejects the response instead of returning 200',
  );

  await assert.rejects(
    worker.handleHttpRequest(mutationRequest('truncate-immediate')),
    /injected clean truncate failure/,
    'a mutation failure that settles before response headers remains visible to the boundary',
  );
}

// Explicit process exit is only an intent until the owning lifecycle has
// drained durability. A failed append cannot be hidden behind an earlier
// terminal exit 0 or lose its writer authorization before the drain.
{
  await manager.spawnNode(`
const fs = require('node:fs');
fs.appendFileSync('/home/user/exit-before-drain.txt', 'A');
process.exit(0);
`, {
    command: 'node exit-before-drain.js',
    filename: '/home/user/exit-before-drain.js',
    cwd: '/home/user',
  });
  const reports = [];
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusProcess(
    createProcessFacetCtx(`vfs-durability-${++facetSeq}`),
    {
      SUPERVISOR: asLaunchSupervisor({
        // The append's wave fails.
        async writeBatchStream() {
          const error = new Error('injected append failure after exit intent');
          error.code = 'EIO';
          throw error;
        },
        async reportExit(code) { reports.push(code); },
        async stdout() {},
        async stderr() {},
      }),
    },
  );
  await assert.rejects(
    worker.startProcess(),
    /injected append failure after exit intent/,
  );
  assert.deepEqual(
    reports,
    [],
    'long-running Node does not report terminal success before durability',
  );
}

// The regular one-shot generated runner follows the same ordering: process.exit
// records the intended code, the append drain runs with live authority, and
// only the final post-drain code is reported.
{
  const reports = [];
  let appendCalls = 0;
  const supervisor = {
    // The append's wave fails, definitively: not a lost call, so not re-sent.
    async writeBatchStream() {
      appendCalls++;
      const error = new Error('injected one-shot append failure');
      error.code = 'EIO';
      throw error;
    },
    async openWaveWriter() { return null; },
    async reportExit(code) { reports.push(code); },
    async stdout() {},
    async stderr() {},
  };
  supervisorFactory = () => supervisor;
  const executingEnv = {
    ...env,
    LOADER: {
      get() {
        throw new Error('one-shot generated runner uses LOADER.load');
      },
      load(config) {
        return {
          getEntrypoint() {
            return {
              async fetch(runRequest) {
                const generated = await importModuleSet(config.modules, 'runner.js');
                return generated.default.fetch(runRequest, config.env);
              },
            };
          },
        };
      },
    },
  };
  const oneShotProcesses = new SessionProcessSupervisor();
  const oneShotManager = new FacetManager(
    { id: { toString: () => 'one-shot-exit-ordering' }, waitUntil() {} },
    executingEnv,
    oneShotProcesses,
    new PortRegistry(),
    processHostFor,
    {},
  );
  const result = await oneShotManager.exec(`
const fs = require('node:fs');
fs.appendFileSync('/home/user/oneshot-exit-before-drain.txt', 'A');
process.exit(0);
`, {
    filename: '<eval>',
    cwd: '/home/user',
    captureOutput: true,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(appendCalls, 1, `definitive EIO is not retried: ${JSON.stringify(result)}`);
  assert.deepEqual(reports, [1], 'only the final failed durability code is reported');
}

console.log('resident-node-request-vfs-durability: ok');
