#!/usr/bin/env bun
// Batched filesystem reads: many ranges, one round trip.
//
// A round trip costs an order of magnitude more than the SQLite lookup behind
// it, so a program that touches thousands of files pays for round trips and
// almost nothing else. `_rpcFsReadBatch` answers many ranges in one call. What
// has to be true for that to be safe:
//
//   - a batch is exactly as authoritative as the reads it replaces — same
//     credential, same live bridge, no snapshot;
//   - one denied or missing path costs the caller that path, not the batch;
//   - the bounds are enforced loudly, because a caller that silently got
//     fewer entries than it asked for would read a truncated file as whole;
//   - a read reserves what it will RETURN, not what it asked for. A 64 KiB
//     range over a 200-byte file retains 200 bytes, and claiming the range
//     lets sixteen trivial reads exhaust the whole read reserve.

import assert from 'node:assert/strict';

import {
  FS_READ_BATCH_PATH_LIMIT,
  FS_READ_BATCH_REQUEST_BYTES,
} from '../../packages/worker/src/constants.ts';
import {
  acquireSupervisorAllocation,
  readSupervisorAllocationBudget,
} from '../../packages/worker/src/observability/heavy-alloc-coord.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import {
  _rpcFsReadBatch,
  _rpcFsReadRange,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const CHUNK = 65536; // READ_STREAM_CHUNK_BYTES — one ranged read
const dec = new TextDecoder();

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernelVfs = rawVfs.as(CRED_KERNEL);

kernelVfs.mkdir('home/user/many', { recursive: true, mode: 0o755 });
const PATHS = [];
for (let i = 0; i < 63; i++) {
  const path = `/home/user/many/f${i}.txt`;
  kernelVfs.writeFile(path.slice(1), `file-${i}-` + 'x'.repeat(i), { mode: 0o644 });
  PATHS.push(path);
}
kernelVfs.mkdir('private', { recursive: true, mode: 0o700 });
kernelVfs.writeFile('private/root.txt', 'root secret', { mode: 0o600 });

const processes = new SessionProcessSupervisor();
const user = processes.spawn('node', ['user.js'], '/home/user');
const root = processes.spawn('node', ['root.js'], '/root', { cred: CRED_KERNEL });

/**
 * The supervisor host, plus a seam on the per-process bridge so a test can
 * observe what the handler reserved while a read is actually in flight. The
 * handler builds bridges lazily and reuses whatever is already registered
 * for the pid, so registering one here is the same object the handler uses.
 */
function makeHost() {
  const calls = { stat: 0, readRange: 0 };
  let observeInFlight = null;
  const host = {
    sqliteFs: rawVfs,
    processes,
    ensureSqliteFs() {},
    runtimeFsBridges: new Map(),
  };
  for (const pid of [user.pid, root.pid]) {
    const bridge = new SqliteRuntimeFsBridge(rawVfs.as(processes.cred(pid)), rawVfs);
    const { stat, readRange } = bridge;
    bridge.stat = (...args) => { calls.stat++; return stat.apply(bridge, args); };
    bridge.readRange = async (...args) => {
      calls.readRange++;
      const bytes = await readRange.apply(bridge, args);
      if (observeInFlight) observeInFlight(readSupervisorAllocationBudget());
      return bytes;
    };
    host.runtimeFsBridges.set(pid, bridge);
  }
  return {
    host,
    calls,
    onInFlight(fn) { observeInFlight = fn; },
  };
}

// ── one call answers what N calls answer, byte for byte ─────────────────
{
  const { host, calls } = makeHost();
  const requests = PATHS.map((path) => ({ path, offset: 0, length: CHUNK }));
  requests.push({ path: '/home/user/many/absent.txt', offset: 0, length: CHUNK });

  const singles = [];
  for (const request of requests) {
    singles.push(await _rpcFsReadRange(host, request.path, request.offset, request.length, user.pid));
  }
  const singleReads = calls.readRange;

  const readRangeBefore = calls.readRange;
  const batch = await _rpcFsReadBatch(host, requests, user.pid);
  const batchReads = calls.readRange - readRangeBefore;

  assert.equal(batch.length, requests.length, 'the batch dropped entries');
  assert.equal(batchReads, singleReads,
    'a batch must perform the same reads as the calls it replaces, no more and no fewer');
  for (let i = 0; i < requests.length; i++) {
    const expected = singles[i];
    const entry = batch[i];
    assert.equal(entry.error, undefined, `entry ${i} failed: ${entry.error?.message}`);
    if (expected === null) {
      assert.equal(entry.bytes, null, `absent path ${requests[i].path} did not report as absent`);
      continue;
    }
    assert.deepEqual(
      Array.from(entry.bytes),
      Array.from(expected),
      `entry ${i} disagrees with the single read of the same range`,
    );
  }
  console.log(`  ${requests.length} ranges answered in 1 call (${requests.length} calls before)`);
}

// ── the batch is live, not a snapshot ───────────────────────────────────
// Async reads are supervisor-authoritative. A batch that served remembered
// bytes would silently reintroduce the staleness the live path exists to
// remove — and it would do so for whole directories at a time.
{
  const { host } = makeHost();
  const path = '/home/user/many/f0.txt';
  const before = await _rpcFsReadBatch(host, [{ path, offset: 0, length: CHUNK }], user.pid);
  assert.equal(dec.decode(before[0].bytes), 'file-0-');

  kernelVfs.writeFile(path.slice(1), 'rewritten-by-a-sibling', { mode: 0o644 });

  const after = await _rpcFsReadBatch(host, [{ path, offset: 0, length: CHUNK }], user.pid);
  assert.equal(dec.decode(after[0].bytes), 'rewritten-by-a-sibling',
    'a batch read served stale bytes after a sibling write — it is not as authoritative as a single read');

  kernelVfs.writeFile(path.slice(1), 'file-0-', { mode: 0o644 });
}

// ── the batch runs under the caller's credential ────────────────────────
{
  const { host } = makeHost();
  const requests = [
    { path: '/home/user/many/f1.txt', offset: 0, length: CHUNK },
    { path: '/private/root.txt', offset: 0, length: CHUNK },
    { path: '/home/user/many/f2.txt', offset: 0, length: CHUNK },
  ];

  const asUser = await _rpcFsReadBatch(host, requests, user.pid);
  assert.equal(asUser[0].error, undefined, 'a readable path failed');
  assert.equal(asUser[1].bytes, undefined,
    'a batch read handed an unprivileged process bytes it cannot read on its own');
  assert.match(asUser[1].error.code ?? asUser[1].error.message, /EACCES/,
    'the denial did not travel with its code');
  assert.equal(asUser[2].error, undefined,
    'one denied path failed the whole batch — N separate reads would have answered the other two');

  const asRoot = await _rpcFsReadBatch(host, requests, root.pid);
  assert.equal(dec.decode(asRoot[1].bytes), 'root secret',
    'the batch ignored the calling process credential');
}

// ── bounds are loud, never a short result ───────────────────────────────
{
  const { host } = makeHost();
  const overPaths = Array.from({ length: FS_READ_BATCH_PATH_LIMIT + 1 }, () => ({
    path: '/home/user/many/f0.txt', offset: 0, length: 16,
  }));
  await assert.rejects(
    _rpcFsReadBatch(host, overPaths, user.pid),
    'a batch over the path limit was accepted',
  );

  const perRange = Math.ceil(FS_READ_BATCH_REQUEST_BYTES / 8) + 1;
  const overBytes = Array.from({ length: 8 }, () => ({
    path: '/home/user/many/f0.txt', offset: 0, length: perRange,
  }));
  await assert.rejects(
    _rpcFsReadBatch(host, overBytes, user.pid),
    /limit/,
    'a batch over the byte budget was accepted — the 32 MiB RPC ceiling is not a bound the caller can be trusted with',
  );

  await assert.rejects(_rpcFsReadBatch(host, [], user.pid), 'an empty batch was accepted');
  await assert.rejects(
    _rpcFsReadBatch(host, [{ path: '/home/user/many/f0.txt', offset: 0, length: 16 }]),
    /process|pid/i,
    'a batch read without a pid cannot default-open the VFS',
  );
}

// ── a read reserves what it returns, not what it asked for ──────────────
// The general lane is held, so a read can only be served from the read
// reserve. Sixteen 64 KiB claims fill that reserve; the same sixteen reads
// over trivial files retain a few hundred bytes between them.
{
  const { host, onInFlight } = makeHost();
  let observed = null;
  onInFlight((stats) => { if (observed === null) observed = stats.current; });

  const held = await acquireSupervisorAllocation(40 * 1024 * 1024);
  const baseline = readSupervisorAllocationBudget().current;
  try {
    const bytes = await _rpcFsReadRange(host, '/home/user/many/f3.txt', 0, CHUNK, user.pid);
    assert.ok(bytes.byteLength < 1024, 'fixture is not a small file');
    assert.ok(observed !== null, 'never observed the budget during a read');
    assert.ok(
      observed - baseline <= bytes.byteLength,
      `a ${bytes.byteLength}-byte read claimed ${observed - baseline} bytes of the read reserve; `
      + 'reserving the request rather than the result serialises trivial reads for no reason',
    );
  } finally {
    held.release();
  }
}

// ── a batch's claim is the sum of what it returns ───────────────────────
{
  const { host, onInFlight } = makeHost();
  let peak = 0;
  onInFlight((stats) => { peak = Math.max(peak, stats.current); });

  const requests = PATHS.map((path) => ({ path, offset: 0, length: CHUNK }));
  const held = await acquireSupervisorAllocation(40 * 1024 * 1024);
  const baseline = readSupervisorAllocationBudget().current;
  let total = 0;
  try {
    const batch = await _rpcFsReadBatch(host, requests, user.pid);
    for (const entry of batch) total += entry.bytes.byteLength;
  } finally {
    held.release();
  }
  const claimed = peak - baseline;
  assert.ok(peak > 0, 'never observed the budget during the batch');
  assert.ok(
    claimed <= total,
    `a batch returning ${total} bytes claimed ${claimed}; `
    + `claiming the ${requests.length * CHUNK}-byte request would exceed the read reserve outright`,
  );
  console.log(`  ${requests.length} ranges over ${requests.length * CHUNK} requested bytes claimed ${claimed} (returned ${total})`);
}

console.log('session-fs-read-batch OK: many ranges, one round trip, same authority');
