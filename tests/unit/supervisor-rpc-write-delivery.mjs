#!/usr/bin/env bun
// A process's filesystem mutation survives the platform dropping the call to
// the session, and applies exactly once.
//
// SupervisorRPC forwards every facet syscall to the session Durable Object.
// Measured on staging: that call occasionally fails "Network connection
// lost." with `retryable: true` — pip's `fsWrite` of a wheel member
// (werkzeug/sansio/utils.py, OSError errno 29) and an 8 MiB FileHandle loop
// (EIO at 4,390,912). The dropped call may or may not have run, so a blind
// repeat could apply it twice or clobber a newer write. Every attempt now
// carries one delivery id and the session applies an id at most once,
// answering a repeat from a receipt committed with the mutation.
//
// Real code on both sides: SupervisorRPC, the session's supervisor-op
// handler, ProcessFiles and SqliteVFS over SQLite. Only the platform's stub
// is simulated — it copies the envelope as the wire does, and drops the call
// before the session runs it or after it ran, as instructed.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import * as coreConstants from '../../packages/core/src/constants.ts';
import { _rpcFsWriteRange } from '../../packages/worker/src/session/rpc.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

// Full-jitter backoff draws its delay from Math.random; zero keeps the
// retries immediate and the run deterministic.
Math.random = () => 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc = new TextEncoder();
const dec = new TextDecoder();
const dropped = () => Object.assign(new Error('Network connection lost.'), { retryable: true });

/** A session Durable Object instance over `harness`'s SQLite: a fresh one is a restart. */
function openSession(harness) {
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const processes = new SessionProcessSupervisor();
  const host = { sqliteFs: vfs, processes, ensureSqliteFs() {} };
  // The routed op the session serves from its own _rpc* surface, as NimbusSession does.
  host._rpcFsWriteRange = (path, offset, bytes, pid) => _rpcFsWriteRange(host, path, offset, bytes, pid);
  attachSupervisorOps(host);
  return { host, vfs, processes };
}

/**
 * The platform between SupervisorRPC and the session: a fresh stub per
 * `get`, the envelope copied on the way in and the answer on the way out,
 * and a queue of faults consumed one per arriving call.
 *   lost-request — dropped before the session runs it
 *   lost-reply   — the session ran it; the answer never comes back
 *                  (`between` runs first: another writer, or a restart)
 */
function world() {
  const harness = createSqliteVfsTestHarness();
  const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  const w = {
    harness,
    session: openSession(harness),
    faults: [],
    arrivals: [],
    stubs: new Set(),
  };
  w.env = {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get() {
        const stub = {
          async supervisorOp(sent) {
            const envelope = structuredClone(sent);
            const fault = w.faults.shift();
            w.arrivals.push({ op: envelope.op, pid: envelope.pid, delivery: envelope.delivery, stub });
            w.stubs.add(stub);
            if (fault?.kind === 'lost-request') throw fault.error ?? dropped();
            const answer = await w.session.host.supervisorOp(envelope);
            if (fault?.kind === 'lost-reply') {
              await fault.between?.();
              throw dropped();
            }
            return structuredClone(answer);
          },
        };
        return stub;
      },
    },
  };
  /** A process in the current session instance and the SUPERVISOR binding it holds. */
  w.process = () => {
    const pid = w.session.processes.spawn('python3', ['python3'], '/home/user').pid;
    return { pid, rpc: new SupervisorRPC({ props: { doId: 'session', pid } }, w.env) };
  };
  w.read = (path) => {
    const bytes = w.session.vfs.as(CRED_KERNEL).readFile(path);
    return typeof bytes === 'string' ? bytes : dec.decode(bytes);
  };
  w.revision = (path) => w.session.vfs.revision(path);
  w.of = (pid) => w.arrivals.filter((arrival) => arrival.pid === pid);
  return w;
}

/** Every attempt of one call carried the same delivery id, each on its own stub. */
function assertOneDelivery(arrivals, op, attempts) {
  assert.equal(arrivals.length, attempts, `${op}: ${arrivals.length} arrivals, expected ${attempts}`);
  for (const arrival of arrivals) assert.equal(arrival.op, op);
  assert.match(arrivals[0].delivery ?? '', UUID, `${op}: the call carried no delivery id`);
  assert.equal(new Set(arrivals.map((arrival) => arrival.delivery)).size, 1, `${op}: a repeat carried a new delivery id`);
  assert.equal(new Set(arrivals.map((arrival) => arrival.stub)).size, attempts, `${op}: a repeat reused a stub that threw`);
}

// ── writeFile ────────────────────────────────────────────────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  w.faults.push({ kind: 'lost-request' });
  const revision = await rpc.writeFile('/home/user/lost-request.txt', 'hello');
  assert.equal(w.read('home/user/lost-request.txt'), 'hello', 'a write dropped before it ran never applied');
  assert.equal(revision, w.revision('home/user/lost-request.txt'), 'the answer is the revision the write produced');
  assertOneDelivery(w.of(pid), 'writeFile', 2);
  console.log('  ok  writeFile dropped before the session ran it applies on the repeat');
}

{
  const w = world();
  const { pid, rpc } = w.process();
  const other = w.process();
  let applied;
  let theirs;
  w.faults.push({
    kind: 'lost-reply',
    between: async () => {
      applied = w.revision('home/user/race.txt');
      assert.equal(w.read('home/user/race.txt'), 'mine', 'the first attempt ran');
      theirs = await other.rpc.writeFile('/home/user/race.txt', 'theirs');
    },
  });
  const revision = await rpc.writeFile('/home/user/race.txt', 'mine');
  assert.equal(w.read('home/user/race.txt'), 'theirs', "the repeat applied again, over another writer's newer write");
  assert.equal(revision, applied, 'the repeat did not answer what the write that ran answered');
  assert.equal(w.revision('home/user/race.txt'), theirs, 'the repeat moved the revision past the other writer');
  assert.ok(revision < theirs, 'the answer is older than the newer write, so the writer can tell it was overtaken');
  assertOneDelivery(w.of(pid), 'writeFile', 2);
  console.log("  ok  writeFile whose reply was lost is answered from its receipt; a newer write stays");
}

// ── fsWrite: the descriptor write pip's copy made ────────────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  const handle = await rpc.fsOpen('/home/user/utils.py', { write: true, create: true, truncate: true });
  w.faults.push({ kind: 'lost-reply' });
  assert.equal(await rpc.fsWrite(handle.id, null, enc.encode('first.')), 6);
  assert.equal(await rpc.fsWrite(handle.id, null, enc.encode('second.')), 7);
  await rpc.fsClose(handle.id);
  assert.equal(w.read('home/user/utils.py'), 'first.second.', 'a repeat wrote at the advanced offset again');
  assertOneDelivery(w.of(pid).filter((arrival) => arrival.op === 'fsWrite').slice(0, 2), 'fsWrite', 2);
  console.log('  ok  fsWrite at the file position whose reply was lost advances the position once');
}

// ── fsWriteRange: a routed mutation, with its revision receipt ───────────

{
  const w = world();
  const { pid, rpc } = w.process();
  const other = w.process();
  await rpc.writeFile('/home/user/range.bin', 'xxxxxxxx');
  const prior = w.revision('home/user/range.bin');
  w.faults.push({ kind: 'lost-request' });
  const first = await rpc.fsWriteRange('/home/user/range.bin', 0, enc.encode('AA'));
  assert.deepEqual(first, { before: prior, after: w.revision('home/user/range.bin') });
  assert.equal(w.read('home/user/range.bin'), 'AAxxxxxx');
  assertOneDelivery(w.of(pid).filter((arrival) => arrival.op === 'fsWriteRange'), 'fsWriteRange', 2);

  let applied;
  w.faults.push({
    kind: 'lost-reply',
    between: async () => {
      applied = w.revision('home/user/range.bin');
      await other.rpc.fsWriteRange('/home/user/range.bin', 2, enc.encode('BBBB'));
    },
  });
  const second = await rpc.fsWriteRange('/home/user/range.bin', 2, enc.encode('CCCC'));
  assert.equal(w.read('home/user/range.bin'), 'AABBBBxx', "the repeat applied again, over another writer's newer range");
  assert.deepEqual(second, { before: first.after, after: applied }, 'the receipt is not the one the write that ran produced');
  assert.ok(second.after < w.revision('home/user/range.bin'), 'the receipt hides the newer write');
  console.log('  ok  fsWriteRange: dropped either side of the session, one application and its own receipt');
}

// ── Namespace ops ────────────────────────────────────────────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  w.faults.push({ kind: 'lost-reply' });
  await rpc.mkdir('/home/user/pkg', { recursive: false });
  assert.equal(w.session.vfs.as(CRED_KERNEL).stat('home/user/pkg')?.type, 'directory');
  assertOneDelivery(w.of(pid), 'mkdir', 2);

  w.faults.push({ kind: 'lost-request' });
  await rpc.mkdir('/home/user/pkg/sub', { recursive: false });
  assert.equal(w.session.vfs.as(CRED_KERNEL).stat('home/user/pkg/sub')?.type, 'directory');
  console.log('  ok  mkdir whose reply was lost answers success, not EEXIST');
}

{
  const w = world();
  const { pid, rpc } = w.process();
  const other = w.process();
  await rpc.writeFile('/home/user/a.txt', 'old');
  w.faults.push({
    kind: 'lost-reply',
    between: async () => { await other.rpc.writeFile('/home/user/a.txt', 'new'); },
  });
  await rpc.rename('/home/user/a.txt', '/home/user/b.txt');
  assert.equal(w.read('home/user/b.txt'), 'old', 'the repeat renamed the newer file over the one that was moved');
  assert.equal(w.read('home/user/a.txt'), 'new', "the other writer's new file was moved away");
  assertOneDelivery(w.of(pid).filter((arrival) => arrival.op === 'rename'), 'rename', 2);
  console.log('  ok  rename whose reply was lost moves once; a new file at the old name stays');
}

// ── The session restarts between attempts ────────────────────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  let restarted;
  w.faults.push({
    kind: 'lost-reply',
    between: async () => {
      // The instance that ran it is gone; a fresh one opens the same SQLite.
      w.session = openSession(w.harness);
      // The writer's pid, registered again in the fresh process table.
      w.session.processes.spawn('python3', ['python3'], '/home/user');
      const other = w.process();
      assert.notEqual(other.pid, pid);
      await other.rpc.writeFile('/home/user/restart.txt', 'after restart');
      restarted = w.revision('home/user/restart.txt');
    },
  });
  const revision = await rpc.writeFile('/home/user/restart.txt', 'before restart');
  assert.equal(w.read('home/user/restart.txt'), 'after restart', 'the new instance applied the repeat again');
  assert.equal(w.revision('home/user/restart.txt'), restarted);
  assert.ok(revision < restarted, 'the answer is the write that ran before the restart');
  assertOneDelivery(w.of(pid), 'writeFile', 2);
  console.log('  ok  a receipt committed with the mutation answers the repeat after a restart');
}

// ── What is not retried, and exhaustion ──────────────────────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  const refused = new Error('storage refused');
  w.faults.push({ kind: 'lost-request', error: refused });
  await assert.rejects(rpc.writeFile('/home/user/permanent.txt', 'x'), (error) => error === refused);
  assert.equal(w.of(pid).length, 1, 'a permanent failure was retried');

  const overloaded = Object.assign(new Error('Durable Object is overloaded.'), { retryable: true, overloaded: true });
  w.faults.push({ kind: 'lost-request', error: overloaded });
  await assert.rejects(rpc.fsWriteRange('/home/user/permanent.txt', 0, enc.encode('x')), (error) => error === overloaded);
  assert.equal(w.of(pid).length, 2, 'an overloaded session was retried');

  // The filesystem's own answer is an answer, and is not a drop.
  await assert.rejects(rpc.mkdir('/home/user/missing/child', { recursive: false }), /ENOENT/);
  assert.equal(w.of(pid).length, 3);
  assert.equal(w.session.vfs.as(CRED_KERNEL).exists('home/user/permanent.txt'), false, 'a refused write applied');
  console.log('  ok  permanent, overloaded and errno failures surface after one attempt');
}

{
  const w = world();
  const { pid, rpc } = w.process();
  w.faults.push({ kind: 'lost-request' }, { kind: 'lost-request' }, { kind: 'lost-request' });
  await assert.rejects(rpc.writeFile('/home/user/never.txt', 'x'), /Network connection lost/);
  assertOneDelivery(w.of(pid), 'writeFile', 3);
  assert.equal(w.session.vfs.as(CRED_KERNEL).exists('home/user/never.txt'), false);
  assert.equal(w.faults.length, 0);

  // Every reply lost: the write ran once, and the caller is still told it failed.
  w.faults.push({ kind: 'lost-reply' }, { kind: 'lost-reply' }, { kind: 'lost-reply' });
  await assert.rejects(rpc.writeFile('/home/user/unanswered.txt', 'once'), /Network connection lost/);
  const unanswered = w.revision('home/user/unanswered.txt');
  assert.equal(w.read('home/user/unanswered.txt'), 'once');
  assert.equal(w.of(pid).length, 6);
  assert.equal(new Set(w.of(pid).slice(3).map((arrival) => arrival.delivery)).size, 1);
  assert.equal(w.revision(), unanswered, 'a repeat of a write that ran applied it again');
  console.log('  ok  exhaustion surfaces the drop, never a silent success, and applied at most once');
}

// ── The session side of the contract ─────────────────────────────────────

{
  const w = world();
  const { pid } = w.process();
  const handle = await w.session.host.supervisorOp({ op: 'fsOpen', args: ['/home/user/r.txt', { write: true, create: true }], pid });
  await assert.rejects(
    w.session.host.supervisorOp({ op: 'fsRead', args: [handle.id, 0, 4], pid, delivery: crypto.randomUUID() }),
    /not delivered once/,
  );
  await assert.rejects(
    w.session.host.supervisorOp({ op: 'writeFile', args: ['/home/user/r.txt', 'x'], pid, delivery: 'not-a-uuid' }),
    /invalid delivery id/,
  );
  // One id is one mutation: a different op under it is refused, not applied.
  const delivery = crypto.randomUUID();
  await w.session.host.supervisorOp({ op: 'mkdir', args: ['/home/user/once', { recursive: false }], pid, delivery });
  await assert.rejects(
    w.session.host.supervisorOp({ op: 'unlink', args: ['/home/user/r.txt'], pid, delivery }),
    /EINVAL/,
  );
  assert.equal(w.session.vfs.as(CRED_KERNEL).exists('home/user/r.txt'), true);
  console.log('  ok  a delivery id rides only a delivered mutation, and names only one');
}

{
  // A mutation still running when a repeat arrives: the repeat joins it. The
  // same pending receipt found by a fresh instance has no runner, and its
  // outcome is unknown: EIO, never a second application.
  const harness = createSqliteVfsTestHarness();
  const first = new SqliteVFS(harness.sql, harness.ctx);
  const delivery = crypto.randomUUID();
  const running = Promise.withResolvers();
  let applied = 0;
  const answer = first.deliverOnce(7, delivery, 'fsCopyTree', () => { applied++; return running.promise; });
  const repeat = first.deliverOnce(7, delivery, 'fsCopyTree', () => { applied++; return 0; });
  const restarted = new SqliteVFS(harness.sql, harness.ctx);
  assert.throws(
    () => restarted.deliverOnce(7, delivery, 'fsCopyTree', () => { applied++; return 0; }),
    (error) => error.code === 'EIO',
  );
  running.resolve(12);
  assert.equal(await answer, 12);
  assert.equal(await repeat, 12, 'the repeat did not join the running mutation');
  assert.equal(first.deliverOnce(7, delivery, 'fsCopyTree', () => { applied++; return 0; }), 12);
  assert.equal(applied, 1);

  // A mutation that fails leaves nothing behind: it did not apply, so a
  // repeat is asked again.
  const failing = crypto.randomUUID();
  await assert.rejects(first.deliverOnce(7, failing, 'fsCopyTree', () => Promise.reject(new Error('ENOSPC: full'))), /ENOSPC/);
  assert.equal(first.deliverOnce(7, failing, 'fsCopyTree', () => 3), 3);
  // Receipts are per process: another pid's id is its own.
  assert.equal(first.deliverOnce(8, delivery, 'fsCopyTree', () => 5), 5);
  console.log('  ok  a running delivery is joined; one orphaned by a restart is EIO');
}

{
  // Retention: a receipt answers for the whole retention and is pruned after
  // it, two for each receipt recorded, so the table never outgrows the rate
  // of mutation times the retention.
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const old = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of old) vfs.deliverOnce(9, id, 'mkdir', () => undefined);
    now += coreConstants.VFS_DELIVERY_RECEIPT_RETENTION_MS;
    let applied = 0;
    assert.equal(vfs.deliverOnce(9, old[0], 'mkdir', () => { applied++; }), undefined);
    assert.equal(applied, 0, 'a receipt inside its retention did not answer');
    const count = () => Number(harness.sql.exec('SELECT COUNT(*) AS n FROM vfs_delivery_receipts')[0].n);
    vfs.deliverOnce(9, crypto.randomUUID(), 'mkdir', () => undefined);
    assert.equal(count(), 4, 'a receipt exactly at its retention was pruned');
    now += 1;
    vfs.deliverOnce(9, crypto.randomUUID(), 'mkdir', () => undefined);
    assert.equal(count(), 3, 'recording a receipt did not prune two expired ones');
    vfs.deliverOnce(9, crypto.randomUUID(), 'mkdir', () => undefined);
    assert.equal(count(), 3, 'the third expired receipt was not pruned by the next record');
  } finally {
    Date.now = realNow;
  }
  console.log('  ok  receipts answer for their retention and are pruned after it');
}

console.log('supervisor-rpc-write-delivery: ok');
