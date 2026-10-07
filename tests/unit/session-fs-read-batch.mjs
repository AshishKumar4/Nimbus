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
} from '../../packages/core/src/constants.ts';
import {
  acquireSupervisorAllocation,
  readSupervisorAllocationBudget,
} from '../../packages/platform/src/heavy-alloc-coord.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import {
  _rpcFsReadBatch,
  _rpcFsReadRange,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';

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
function makeHost({ deliveries } = {}) {
  const calls = { stat: 0, readRange: 0 };
  let observeInFlight = null;
  const host = {
    sqliteFs: rawVfs,
    processes,
    ensureSqliteFs() {},
    supervisorDeliveries: deliveries,
  };
  // The session's bridge store, pre-seeded with instrumented bridges — the
  // same objects the handler serves from, so a read in flight is observable.
  const store = createSupervisorBridgeStore({ vfs: rawVfs, processes });
  const bridgeByPid = new Map();
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
    bridgeByPid.set(pid, bridge);
  }
  const injected = {
    bridge: (p) => bridgeByPid.get(p) ?? store.bridge(p),
    forget: store.forget,
  };
  const ops = buildSessionSupervisorOps(host, injected);
  host.supervisorOp = (envelope) => ops.dispatch(envelope);
  host.supervisorBridge = (p) => ops.bridge(p);
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

// ── an lstat rides the batch and answers what the lstat op answers ──────
// The node shims learn a path's metadata after each refetch; a resumption
// refetches every path a program wrote, so each learn is an lstat request in
// the batch rather than a round trip of its own. It must be the lstat op's
// answer exactly: the authority's stat, never followed through a symlink,
// null for a path that is not there, a denial in its own slot.
{
  const { host } = makeHost();
  kernelVfs.symlink('many/f3.txt', 'home/user/link');
  const lstatPaths = [
    '/home/user/many/f3.txt',
    '/home/user/link',
    '/home/user/many/absent.txt',
    '/private/root.txt',
    '/home/user/many',
  ];
  const requests = [
    { path: '/home/user/many/f4.txt', offset: 0, length: CHUNK },
    ...lstatPaths.map((path) => ({ path, lstat: true })),
    { path: '/home/user/many/f5.txt', offset: 0, length: CHUNK },
  ];
  const batch = await _rpcFsReadBatch(host, requests, user.pid);
  assert.equal(batch.length, requests.length);
  assert.equal(dec.decode(batch[0].bytes), 'file-4-xxxx', 'a range beside the lstats read wrong');
  assert.equal(dec.decode(batch.at(-1).bytes), 'file-5-xxxxx', 'a range beside the lstats read wrong');
  for (let i = 0; i < lstatPaths.length; i++) {
    const entry = batch[i + 1];
    assert.equal(entry.bytes, undefined, `the lstat of ${lstatPaths[i]} answered bytes`);
    const single = await host.supervisorOp({ op: 'lstat', args: [lstatPaths[i]], pid: user.pid })
      .then((stat) => ({ stat: stat ?? null }), (error) => ({ code: error.code }));
    if (single.code !== undefined) {
      assert.equal(entry.error?.code, single.code, `the lstat of ${lstatPaths[i]} did not fail as the lstat op does`);
    } else {
      assert.equal(entry.error, undefined, `the lstat of ${lstatPaths[i]} failed: ${entry.error?.message}`);
      assert.deepEqual(entry.stat, single.stat, `the lstat of ${lstatPaths[i]} disagrees with the lstat op`);
    }
  }
  assert.equal(batch[2].stat.type, 'symlink', 'the lstat followed the symlink');
  assert.equal(batch[3].stat, null, 'an absent path did not answer null');
  assert.equal(batch[4].error?.code, 'EACCES', 'a path the process cannot reach was not denied');

  // An lstat returns no file bytes, so it spends nothing of the byte bound:
  // a batch already at that bound still carries it.
  const full = Array.from({ length: FS_READ_BATCH_REQUEST_BYTES / CHUNK }, () => ({
    path: '/home/user/many/f0.txt', offset: 0, length: CHUNK,
  }));
  const atBound = await _rpcFsReadBatch(host, [...full, { path: '/home/user/many/f0.txt', lstat: true }], user.pid);
  assert.equal(atBound.at(-1).stat.type, 'file');

  // A request naming a range is a range, lstat or not.
  const both = await _rpcFsReadBatch(host, [{ path: '/home/user/many/f0.txt', lstat: true, offset: 0, length: CHUNK }], user.pid);
  assert.equal(dec.decode(both[0].bytes), 'file-0-');
  assert.equal(both[0].stat, undefined);
  kernelVfs.unlink('home/user/link');
  console.log('  lstat requests answer as the lstat op does, beside ranges, outside the byte bound');
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

  // ── a batch at the FULL path bound is ANSWERED, not merely permitted ──────
  //
  // The bound was raised from 128 to 1024 because for real installs the path
  // cap set the fill cost while the byte cap did the safety work. A nominal
  // limit is not evidence that the limit works: this asks for the maximum
  // width in ONE call over that many DISTINCT real files and checks every
  // entry positionally, so a batch that quietly answered the wrong path or
  // returned short would fail here.
  kernelVfs.mkdir('home/user/wide', { recursive: true, mode: 0o755 });
  const wide = [];
  const expected = [];
  for (let i = 0; i < FS_READ_BATCH_PATH_LIMIT; i++) {
    const body = `wide-${i}`;
    kernelVfs.writeFile(`home/user/wide/w${i}.txt`, body, { mode: 0o644 });
    wide.push({ path: `/home/user/wide/w${i}.txt`, offset: 0, length: 64 });
    expected.push(body);
  }
  const answered = await _rpcFsReadBatch(host, wide, user.pid);
  assert.equal(answered.length, FS_READ_BATCH_PATH_LIMIT,
    `a full-width batch must answer every range, got ${answered.length}`);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(answered[i].error, undefined,
      `entry ${i} errored: ${answered[i].error?.message}`);
    assert.equal(dec.decode(answered[i].bytes), expected[i],
      `entry ${i} did not carry its own path's bytes — positional matching breaks at full width`);
  }

  // ── many small files are not automatically a small payload ───────────────
  //
  // The byte cap does the safety work now that the path cap is wide, so the
  // case that matters is a batch that LOOKS like small files and is not:
  // FS_READ_BATCH_PATH_LIMIT ranges sized past the budget. It must reject
  // loudly rather than truncate, because a caller handed fewer entries than it
  // asked for would read a truncated file as a whole one.
  const perRangeWide = Math.ceil(FS_READ_BATCH_REQUEST_BYTES / FS_READ_BATCH_PATH_LIMIT) * 2;
  const deceptive = Array.from({ length: FS_READ_BATCH_PATH_LIMIT }, (_v, i) => ({
    path: `/home/user/many/f${i % 63}.txt`, offset: 0, length: perRangeWide,
  }));
  assert.ok(
    deceptive.reduce((n, r) => n + r.length, 0) > FS_READ_BATCH_REQUEST_BYTES,
    'the fixture must actually exceed the byte budget, or it proves nothing',
  );
  await assert.rejects(
    _rpcFsReadBatch(host, deceptive, user.pid),
    /limit/,
    'a full-width batch whose ranges exceed the byte budget must still be refused',
  );

  // A batch with no pid comes from the host — the SDK, the remote /rpc
  // dispatcher — not from a process. It reads as the unprivileged session
  // user, never as the kernel, so a root-only path stays denied.
  const hostBatch = await _rpcFsReadBatch(
    host,
    [
      { path: '/home/user/many/f0.txt', offset: 0, length: 16 },
      { path: '/private/root.txt', offset: 0, length: 8 },
    ],
  );
  assert.equal(dec.decode(hostBatch[0].bytes), 'file-0-');
  assert.match(
    hostBatch[1].error.code ?? hostBatch[1].error.message,
    /EACCES/,
    'a pid-less batch read must not reach a root-only file',
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

// ── a repeat of a read still queued joins it: read once ───────────────────
// The supervisor re-sends a read the platform dropped and hedges one that
// has not answered, every attempt under one read id. A batch too big for the
// read reserve waits here behind the general lane (a vite boot holds it for
// seconds), and that wait is what fires the hedge — which must not read the
// same bytes a second time when both arrive.
{
  const deliveries = new SupervisorDeliveries();
  const { host, calls } = makeHost({ deliveries });
  // The route the session serves fsReadBatch through (NimbusSession._rpcFsReadBatch).
  host._rpcFsReadBatch = (batch, pid) => _rpcFsReadBatch(host, batch, pid);
  kernelVfs.writeFile('home/user/many/big.bin', new Uint8Array(32 * CHUNK).fill(9), { mode: 0o644 });
  const requests = Array.from({ length: 32 }, (_, i) => ({ path: '/home/user/many/big.bin', offset: i * CHUNK, length: CHUNK }));
  const readId = crypto.randomUUID();
  const envelope = { op: 'fsReadBatch', args: [requests], pid: user.pid, readId };
  const held = await acquireSupervisorAllocation(40 * 1024 * 1024);
  const statsBefore = calls.stat;
  let first;
  let hedge;
  try {
    first = host.supervisorOp(envelope);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.readRange, 0, 'the batch was not held behind the lane, so this proves nothing');
    hedge = host.supervisorOp(structuredClone(envelope));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries.readsServing, 1);
  } finally {
    held.release();
  }
  const [a, b] = await Promise.all([first, hedge]);
  assert.equal(calls.readRange, requests.length, `${calls.readRange} ranges read for one batch of ${requests.length}`);
  assert.equal(calls.stat - statsBefore, requests.length, 'the repeat sized the batch again');
  assert.equal(a.length, requests.length);
  assert.deepEqual(b.map((entry) => entry.bytes.byteLength), a.map((entry) => entry.bytes.byteLength));
  assert.equal(deliveries.readsServing, 0, 'a settled read was kept');

  // Settled, the id joins nothing: an attempt after it reads afresh.
  await host.supervisorOp(structuredClone(envelope));
  assert.equal(calls.readRange, 2 * requests.length);

  // Only a read carries a read id, and only a well-formed one; a repeat
  // naming another op is refused. (That a repeat is admitted only for the
  // live process that sent it: supervisor-rpc-write-delivery, over the real
  // bridge store — this harness's bridges ignore the credential.)
  await assert.rejects(host.supervisorOp({ op: 'writeFile', args: ['/home/user/many/x', 'y'], pid: user.pid, readId }), /not a read/);
  await assert.rejects(host.supervisorOp({ ...envelope, readId: 'not-a-uuid' }), /not one/);
  const held2 = await acquireSupervisorAllocation(40 * 1024 * 1024);
  const queued = host.supervisorOp({ ...envelope, readId: crypto.randomUUID() });
  const other = { ...envelope, readId: crypto.randomUUID() };
  const running = host.supervisorOp(other);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deliveries.readsServing, 2);
  await assert.rejects(host.supervisorOp({ ...other, op: 'fsReadRange', args: ['/home/user/many/big.bin', 0, CHUNK] }), /EINVAL/);
  held2.release();
  await Promise.all([queued, running]);
  kernelVfs.unlink('home/user/many/big.bin');
  console.log(`  a repeat of a queued ${requests.length}-range batch joined it: ${requests.length} ranges read, not ${2 * requests.length}`);
}

// ── a read names the file it reached, only when that name is its receipt ─
// A synchronous read and the name it reached are taken in one step, so a
// link a peer retargets cannot come between them. An asynchronous read
// awaits, and a name looked up after it would pair one file's bytes with
// another's name, so it carries none.
{
  kernelVfs.writeFile('home/user/many/target.txt', 'target', { mode: 0o644 });
  kernelVfs.symlink('target.txt', 'home/user/many/link.txt');
  const { host } = makeHost();
  const plain = processes.spawn('node', ['plain.js'], '/home/user');
  const [viaLink, direct, absent] = await _rpcFsReadBatch(host, [
    { path: '/home/user/many/link.txt', offset: 0, length: CHUNK },
    { path: '/home/user/many/target.txt', offset: 0, length: CHUNK },
    { path: '/home/user/many/absent.txt', offset: 0, length: CHUNK },
  ], plain.pid);
  assert.equal(dec.decode(viaLink.bytes), 'target');
  assert.equal(viaLink.path, '/home/user/many/target.txt', 'a read through a link names its target');
  assert.equal(direct.path, '/home/user/many/target.txt');
  assert.deepEqual(absent, { bytes: null }, 'nothing read, nothing named');
  const [awaited] = await _rpcFsReadBatch(host, [{ path: '/home/user/many/link.txt', offset: 0, length: CHUNK }], user.pid);
  assert.equal(dec.decode(awaited.bytes), 'target');
  assert.equal('path' in awaited, false, 'an awaited read names nothing');
}

console.log('session-fs-read-batch OK: many ranges, one round trip, same authority');
