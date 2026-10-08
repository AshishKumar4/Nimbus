#!/usr/bin/env bun
// A process's filesystem mutation survives the platform dropping the call to
// the session, and applies exactly once.
//
// SupervisorRPC forwards every facet syscall to the session Durable Object.
// Measured on staging: that call occasionally fails "Network connection
// lost." with `retryable: true` — pip's `fsWrite` of a wheel member
// (werkzeug/sansio/utils.py, OSError errno 29) and an 8 MiB FileHandle loop
// (EIO at 4,390,912). The dropped call may or may not have run, so a blind
// repeat could apply it twice or clobber a newer write. On a binding that
// names its host instance (`hostIncarnation`), every attempt carries one
// delivery id under the `deliverOnce` op, and that instance applies an id at
// most once, answering a repeat from the receipt it kept in memory. Any
// other instance, and any host that predates delivery, refuses outright.
//
// Real code on both sides: SupervisorRPC, the session's supervisor-op
// handler, ProcessFiles and SqliteVFS over SQLite. Only the platform's stub
// is simulated — it copies the envelope as the wire does, and drops the call
// before the session runs it or after it ran, as instructed.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import * as coreConstants from '../../packages/core/src/constants.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import {
  SupervisorDeliveries,
  openSupervisorDeliveries,
  supervisorDeliveryAnswer,
  supervisorDeliveryProps,
} from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';

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
const sqlWrites = (statements) => statements.filter((statement) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.sql));

/**
 * One session Durable Object instance over `harness`'s SQLite: a fresh one is
 * a restart. `deliveries: false` is a host that applies nothing once — what
 * a session that predates delivery answers.
 */
function openSession(harness, { deliveries = true } = {}) {
  const ctx = {};
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const processes = new SessionProcessSupervisor();
  const files = new ProcessFiles(vfs);
  const host = { sqliteFs: vfs, processes, ensureSqliteFs() {} };
  if (deliveries) host.supervisorDeliveries = openSupervisorDeliveries(ctx);
  attachSupervisorOps(host, buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem: files })));
  return { ctx, host, vfs, processes, files };
}

/**
 * The platform between SupervisorRPC and the session: a fresh stub per
 * `get`, the envelope copied on the way in and the answer on the way out,
 * and a queue of faults consumed one per arriving call.
 *   lost-request — dropped before the session runs it
 *   lost-reply   — the session ran it; the answer never comes back
 *                  (`between` runs first: another writer, or a restart)
 *   `stall`      — on any fault: the session reaches this call only after
 *                  that many ms (the clock the test hands Date.now moves)
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
            w.arrivals.push({
              op: envelope.delivery?.op ?? envelope.op,
              wire: envelope.op,
              pid: envelope.pid,
              id: envelope.delivery?.id,
              envelope,
              stub,
            });
            await fault?.stall?.();
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
  /** A process of the current session instance and the SUPERVISOR binding that instance mints for it. */
  w.process = () => {
    const pid = w.session.processes.spawn('python3', ['python3'], '/home/user').pid;
    const hostIncarnation = supervisorDeliveryProps(w.session.ctx).hostIncarnation;
    return { pid, rpc: new SupervisorRPC({ props: { doId: 'session', pid, hostIncarnation, writerId: 'write-run' } }, w.env) };
  };
  w.read = (path) => dec.decode(w.session.vfs.as(CRED_KERNEL).readFile(path));
  w.exists = (path) => w.session.vfs.as(CRED_KERNEL).exists(path);
  w.revision = (path) => w.session.vfs.revision(path);
  w.of = (pid) => w.arrivals.filter((arrival) => arrival.pid === pid);
  return w;
}

/** Every attempt of one call carried the same delivery id under `deliverOnce`, each on its own stub. */
function assertOneDelivery(arrivals, op, attempts) {
  assert.equal(arrivals.length, attempts, `${op}: ${arrivals.length} arrivals, expected ${attempts}`);
  for (const arrival of arrivals) {
    assert.equal(arrival.op, op);
    assert.equal(arrival.wire, 'deliverOnce', `${op}: travelled as '${arrival.wire}', which a host that predates delivery would apply`);
  }
  assert.match(arrivals[0].id ?? '', UUID, `${op}: the call carried no delivery id`);
  assert.equal(new Set(arrivals.map((arrival) => arrival.id)).size, 1, `${op}: a repeat carried a new delivery id`);
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
  await rpc.writeFile('/home/user/lost-request.txt', 'again');
  assert.notEqual(w.of(pid)[2].id, w.of(pid)[0].id, 'a second mutation reused the first one\'s delivery id');
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

// ── fsWriteRange: the FileHandle loop's write, with its revision receipt ─

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

// ── Another instance, or a host that predates delivery ───────────────────

{
  const w = world();
  const { pid, rpc } = w.process();
  const hostIncarnation = supervisorDeliveryProps(w.session.ctx).hostIncarnation;
  await rpc.writeFile('/home/user/restart.txt', 'before restart');
  const revision = w.revision('home/user/restart.txt');
  w.session = openSession(w.harness);
  w.session.processes.setPidBase(1_000_000);
  const gone = (error) => error.code === 'ESRCH' && error.message === `process pid ${pid} does not exist`;
  await assert.rejects(rpc.stat('/home/user/restart.txt'), gone, 'a restarted session refuses the old process read as ESRCH');
  await assert.rejects(rpc.writeFile('/home/user/restart.txt', 'stale process'), gone, 'the same process mutation gets ESRCH, not the stale-binding refusal');
  const current = w.process();
  const stale = new SupervisorRPC({ props: { doId: 'session', pid: current.pid, hostIncarnation, writerId: 'write-run' } }, w.env);
  await assert.rejects(stale.writeFile('/home/user/restart.txt', 'stale binding'), (error) => error.code === 'ESTALE');
  assert.equal(w.read('home/user/restart.txt'), 'before restart');
  assert.equal(w.revision('home/user/restart.txt'), revision, 'neither refusal changed the file');
  await current.rpc.writeFile('/home/user/restart.txt', 'current process');
  assert.equal(w.read('home/user/restart.txt'), 'current process', 'a current process and binding can still write');
  console.log('  ok  a restarted process gets ESRCH on reads and mutations; a live process with a stale binding gets ESTALE');
}

{
  // The session restarts between attempts. Its receipts died with it, so the
  // new instance cannot tell whether the write ran: it refuses the repeat —
  // permanently, since the process it came from died with that instance too.
  const w = world();
  const { pid, rpc } = w.process();
  let restarted;
  w.faults.push({
    kind: 'lost-reply',
    between: async () => {
      w.session = openSession(w.harness);
      // The writer's pid, registered again in the fresh process table: what
      // refuses the repeat is the instance, not a missing process.
      assert.equal(w.session.processes.spawn('python3', ['python3'], '/home/user').pid, pid);
      const other = w.process();
      await other.rpc.writeFile('/home/user/restart.txt', 'after restart');
      restarted = w.revision('home/user/restart.txt');
    },
  });
  await assert.rejects(rpc.writeFile('/home/user/restart.txt', 'before restart'), /ESTALE/);
  assert.equal(w.read('home/user/restart.txt'), 'after restart', 'the new instance applied the repeat');
  assert.equal(w.revision('home/user/restart.txt'), restarted);
  assertOneDelivery(w.of(pid), 'writeFile', 2);
  console.log("  ok  a repeat that reaches a restarted instance is refused, never applied again");
}

{
  // The reviewer's aliasing case: an open whose reply was lost across a
  // restart, and a concurrent open through the same binding. Descriptor
  // numbering starts again in the new instance; a replayed descriptor from
  // the old one would name the new file.
  const w = world();
  const { pid, rpc } = w.process();
  let concurrent;
  w.faults.push({
    kind: 'lost-reply',
    between: async () => {
      w.session = openSession(w.harness);
      assert.equal(w.session.processes.spawn('python3', ['python3'], '/home/user').pid, pid);
      concurrent = await rpc.fsOpen('/home/user/b.txt', { write: true, create: true }).catch((error) => error);
    },
  });
  await assert.rejects(rpc.fsOpen('/home/user/a.txt', { write: true, create: true }), /ESTALE/);
  assert.match(String(concurrent), /ESTALE/, 'a binding of the dead instance opened a descriptor in the new one');
  assert.equal(w.exists('home/user/b.txt'), false, 'the new instance served the dead instance\'s binding');
  console.log('  ok  a dead instance\'s binding is refused by its successor: no descriptor aliases');
}

{
  // A host that predates delivery, or applies nothing once, serves no
  // `deliverOnce`: its refusal is permanent, so the mutation is neither
  // applied nor repeated — the deploy- and rollback-boundary case where an
  // old session applied a write, recorded nothing, and a repeat applied it
  // again.
  const w = world();
  w.session = openSession(w.harness, { deliveries: false });
  const pid = w.session.processes.spawn('python3', ['python3'], '/home/user').pid;
  const handle = await w.session.host.supervisorOp({ op: 'fsOpen', args: ['/home/user/wheel.py', { write: true, create: true }], pid });
  const rpc = new SupervisorRPC({ props: { doId: 'session', pid, hostIncarnation: crypto.randomUUID(), writerId: 'write-run' } }, w.env);
  w.faults.push({ kind: 'lost-reply' });
  await assert.rejects(rpc.fsWrite(handle.id, null, enc.encode('member.')), /supervisor op: 'deliverOnce' is not served by this host/);
  assert.equal(w.of(pid).length, 1, 'a refused delivery was repeated');
  assert.equal(w.read('home/user/wheel.py'), '', 'a host that could not dedupe it applied the write');
  // And a binding such a host mints — none names an incarnation — sends plainly.
  const plain = new SupervisorRPC({ props: { doId: 'session', pid, writerId: 'write-run' } }, w.env);
  assert.equal(await plain.fsWrite(handle.id, null, enc.encode('member.')), 7);
  assert.equal(w.of(pid).at(-1).wire, 'fsWrite');
  assert.equal(w.read('home/user/wheel.py'), 'member.');
  console.log('  ok  a host without delivery refuses deliverOnce permanently; its own bindings send plainly');
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
  assert.equal(w.exists('home/user/permanent.txt'), false, 'a refused write applied');
  console.log('  ok  permanent, overloaded and errno failures surface after one attempt');
}

{
  const w = world();
  const { pid, rpc } = w.process();
  w.faults.push({ kind: 'lost-request' }, { kind: 'lost-request' }, { kind: 'lost-request' });
  await assert.rejects(rpc.writeFile('/home/user/never.txt', 'x'), /Network connection lost/);
  assertOneDelivery(w.of(pid), 'writeFile', 3);
  assert.equal(w.exists('home/user/never.txt'), false);
  assert.equal(w.faults.length, 0);

  // Every reply lost: the write ran once, and the caller is still told it failed.
  w.faults.push({ kind: 'lost-reply' }, { kind: 'lost-reply' }, { kind: 'lost-reply' });
  await assert.rejects(rpc.writeFile('/home/user/unanswered.txt', 'once'), /Network connection lost/);
  const unanswered = w.revision('home/user/unanswered.txt');
  assert.equal(w.read('home/user/unanswered.txt'), 'once');
  assert.equal(w.of(pid).length, 6);
  assert.equal(new Set(w.of(pid).slice(3).map((arrival) => arrival.id)).size, 1);
  assert.equal(w.revision(), unanswered, 'a repeat of a write that ran applied it again');
  console.log('  ok  exhaustion surfaces the drop, never a silent success, and applied at most once');
}

// ── The session side of the contract ─────────────────────────────────────

{
  const w = world();
  const { pid } = w.process();
  const { host } = w.session;
  const hostIncarnation = supervisorDeliveryProps(w.session.ctx).hostIncarnation;
  const deliver = (op, args, extra = {}) => host.supervisorOp({
    op: 'deliverOnce', args, pid, delivery: { op, id: crypto.randomUUID(), hostIncarnation }, ...extra,
  });
  const handle = await host.supervisorOp({ op: 'fsOpen', args: ['/home/user/r.txt', { write: true, create: true }], pid });
  await assert.rejects(deliver('fsRead', [handle.id, 0, 4]), /names no mutation it can deliver once/);
  await assert.rejects(
    host.supervisorOp({ op: 'writeFile', args: ['/home/user/r.txt', 'x'], pid, delivery: { op: 'writeFile', id: crypto.randomUUID(), hostIncarnation } }),
    /cannot carry a delivery/,
  );
  await assert.rejects(
    host.supervisorOp({ op: 'deliverOnce', args: ['/home/user/r.txt', 'x'], pid, delivery: { op: 'writeFile', id: 'not-a-uuid', hostIncarnation } }),
    /names no mutation it can deliver once/,
  );
  await assert.rejects(deliver('writeFile', ['/home/user/r.txt', 'x'], { pid: undefined }), /names no process/);
  await assert.rejects(
    host.supervisorOp({ op: 'deliverOnce', args: ['/home/user/r.txt', 'x'], pid, delivery: { op: 'writeFile', id: crypto.randomUUID(), hostIncarnation: crypto.randomUUID() } }),
    /ESTALE/,
  );
  // One id is one mutation: a different op under it is refused, not applied.
  const id = crypto.randomUUID();
  await host.supervisorOp({ op: 'deliverOnce', args: ['/home/user/once', { recursive: false }], pid, delivery: { op: 'mkdir', id, hostIncarnation } });
  await assert.rejects(
    host.supervisorOp({ op: 'deliverOnce', args: ['/home/user/r.txt'], pid, delivery: { op: 'unlink', id, hostIncarnation } }),
    /EINVAL/,
  );
  assert.equal(w.exists('home/user/r.txt'), true);
  console.log('  ok  deliverOnce carries only a delivered mutation of this instance, and an id names only one');
}

{
  // Identity before receipt: a receipt answers only for the live process it
  // was recorded for. A cred riding the pid, and a process released since,
  // are refused although the receipt is still held.
  const w = world();
  const { pid } = w.process();
  const { host } = w.session;
  const envelope = {
    op: 'deliverOnce',
    args: ['/home/user/id.txt', 'mine'],
    pid,
    delivery: { op: 'writeFile', id: crypto.randomUUID(), hostIncarnation: supervisorDeliveryProps(w.session.ctx).hostIncarnation },
  };
  const revision = await host.supervisorOp(envelope);
  assert.equal(await host.supervisorOp(envelope), revision, 'a repeat was not answered from its receipt');
  await assert.rejects(host.supervisorOp({ ...envelope, cred: CRED_KERNEL }), /cred cannot ride a pid/);
  await w.session.files.releaseProcess(pid);
  await assert.rejects(host.supervisorOp(envelope), /ESTALE: process released/);
  await assert.rejects(host.supervisorOp({ ...envelope, pid: pid + 1000 }), /does not exist/);
  assert.equal(w.read('home/user/id.txt'), 'mine');
  console.log('  ok  identity is checked before a receipt answers: a released or foreign pid is refused');
}

{
  // What a delivery costs: nothing in storage. The same sequence — a write,
  // a read-only open, seek and close, another write — issues exactly the same
  // SQL delivered as plain, and the open, seek and close write none.
  const run = async (delivered) => {
    const w = world();
    const { pid } = w.process();
    const { host } = w.session;
    const hostIncarnation = supervisorDeliveryProps(w.session.ctx).hostIncarnation;
    const send = (op, args) => host.supervisorOp(delivered
      ? { op: 'deliverOnce', args, pid, delivery: { op, id: crypto.randomUUID(), hostIncarnation } }
      : { op, args, pid });
    const from = w.harness.statements.length;
    await send('writeFile', ['/home/user/mod.py', 'print(1)']);
    const opened = w.harness.statements.length;
    const handle = await send('fsOpen', ['/home/user/mod.py', { read: true }]);
    await send('fsSeek', [handle.id, 0, 'set']);
    await send('fsClose', [handle.id]);
    const closed = w.harness.statements.length;
    await send('writeFile', ['/home/user/next.py', 'x'.repeat(100)]);
    const statements = w.harness.statements;
    return {
      sql: statements.slice(from).map((statement) => statement.sql),
      readOnlyWrites: sqlWrites(statements.slice(opened, closed)),
    };
  };
  const plain = await run(false);
  const delivered = await run(true);
  assert.deepEqual(delivered.readOnlyWrites, [], 'a delivered read-only open, seek and close wrote SQL');
  assert.deepEqual(plain.readOnlyWrites, []);
  assert.deepEqual(delivered.sql, plain.sql, 'a delivery changed what the session asked of SQLite');
  console.log(`  ok  a delivery writes nothing to storage (open/seek/close: 0 writes; ${plain.sql.length} statements either way)`);
}

// ── A repeated read joins the one being served, for its own process only ──

{
  // SupervisorRPC sends every attempt of a read under one read id: a repeat
  // arriving while the read is still being served joins it, and the session
  // reads once. The read here waits on a gate, as one queued behind the
  // session's read budget does.
  const w = world();
  const { pid } = w.process();
  const { host, files } = w.session;
  w.session.vfs.as(CRED_KERNEL).writeFile('home/user/joined.txt', 'joined bytes');
  let gate = Promise.withResolvers();
  let served = 0;
  host._rpcFsReadBatch = async (requests, p) => {
    served++;
    await gate.promise;
    return _rpcFsReadBatch(host, requests, p);
  };
  const read = () => ({
    op: 'fsReadBatch', args: [[{ path: '/home/user/joined.txt', offset: 0, length: 64 }]], pid, readId: crypto.randomUUID(),
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  const envelope = read();
  const first = host.supervisorOp(envelope);
  await tick();
  const repeat = host.supervisorOp(structuredClone(envelope));
  await tick();
  assert.equal(served, 1, 'the repeat read again instead of joining');
  gate.resolve();
  const [a, b] = await Promise.all([first, repeat]);
  assert.equal(dec.decode(a[0].bytes), 'joined bytes');
  assert.equal(dec.decode(b[0].bytes), 'joined bytes');
  assert.equal(served, 1);

  // A repeat is admitted only for the live process that sent the read: not
  // with a credential riding the pid, not once the process is released.
  gate = Promise.withResolvers();
  const held = read();
  const heldRead = host.supervisorOp(held).catch((error) => error);
  await tick();
  await assert.rejects(host.supervisorOp({ ...held, cred: CRED_KERNEL }), /cred cannot ride a pid/);
  await files.releaseProcess(pid);
  await assert.rejects(host.supervisorOp(structuredClone(held)), /ESTALE/);
  assert.equal(served, 2, 'a refused repeat read');
  gate.resolve();
  await heldRead;
  console.log('  ok  a repeated read id joins the read in flight, and only for its live process');
}

// ── The receipt store ─────────────────────────────────────────────────────

{
  // A mutation still running when a repeat arrives: the repeat joins it and
  // gets the same answer. One that failed answers its repeat with the same
  // failure — it is never applied a second time. Receipts are per process.
  const store = new SupervisorDeliveries();
  const id = crypto.randomUUID();
  const running = Promise.withResolvers();
  let applied = 0;
  const first = store.deliver(7, id, 'fsCopyTree', () => { applied++; return running.promise; });
  const repeat = store.deliver(7, id, 'fsCopyTree', () => { applied++; return 0; });
  assert.deepEqual([first.receipt, repeat.receipt], ['applied', 'awaited']);
  running.resolve(12);
  assert.equal(await first.answer, 12);
  assert.equal(await repeat.answer, 12, 'the repeat did not join the running mutation');
  const settled = store.deliver(7, id, 'fsCopyTree', () => { applied++; return 0; });
  assert.deepEqual(settled, { receipt: 'replayed', answer: 12 });
  assert.equal(applied, 1);

  for (const fail of [() => Promise.reject(new Error('ENOSPC: full')), () => { throw new Error('ENOSPC: full'); }]) {
    const failing = crypto.randomUUID();
    let tries = 0;
    const attempt = () => { tries++; return fail(); };
    await assert.rejects(async () => store.deliver(7, failing, 'fsCopyTree', attempt).answer, /ENOSPC/);
    await assert.rejects(async () => store.deliver(7, failing, 'fsCopyTree', attempt).answer, /ENOSPC/);
    assert.equal(tries, 1, 'a repeat of a failed mutation applied it again');
  }
  assert.equal(store.deliver(8, id, 'fsCopyTree', () => 5).answer, 5, 'another pid\'s id was answered from this one\'s receipt');
  assert.notEqual(new SupervisorDeliveries().incarnation, store.incarnation);
  assert.equal(store.incarnation, store.incarnation);

  // A repeat is answered with the very value the first delivery answered.
  const handle = { id: 3, path: 'home/user/f', flags: { write: true }, position: 0, closed: false };
  const opened = crypto.randomUUID();
  assert.equal(store.deliver(9, opened, 'fsOpen', () => handle).answer, handle);
  assert.equal(store.deliver(9, opened, 'fsOpen', () => ({ ...handle, id: 4 })).answer, handle);
  console.log('  ok  a running delivery is joined; a failure answers its repeat; receipts are per process');
}

{
  // The reviewer's atomicity case: a durable receipt INSERT that failed after
  // the write applied told the caller it failed, and the repeat wrote again
  // (AB → ABAB). Now nothing but the mutation touches storage, and its
  // outcome is what the repeat meets: a write the storage refused is refused
  // again, never half-recorded.
  const w = world();
  const { pid } = w.process();
  const { host } = w.session;
  const handle = await host.supervisorOp({ op: 'fsOpen', args: ['/home/user/w.txt', { write: true, create: true }], pid });
  const envelope = {
    op: 'deliverOnce',
    args: [handle.id, null, enc.encode('AB')],
    pid,
    delivery: { op: 'fsWrite', id: crypto.randomUUID(), hostIncarnation: supervisorDeliveryProps(w.session.ctx).hostIncarnation },
  };
  w.harness.setFaultInjector((statement) => /^\s*(INSERT|UPDATE|DELETE)/i.test(statement.sql) ? new Error('SQLITE_FULL: database or disk is full') : null);
  await assert.rejects(host.supervisorOp(envelope), /SQLITE_FULL/);
  w.harness.clearFault();
  await assert.rejects(host.supervisorOp(envelope), /SQLITE_FULL/, 'the repeat of a refused write was applied');
  assert.equal(w.read('home/user/w.txt'), '', 'a refused write left bytes behind');
  const written = await host.supervisorOp({ ...envelope, delivery: { ...envelope.delivery, id: crypto.randomUUID() } });
  assert.equal(written, 2);
  assert.equal(await host.supervisorOp({ ...envelope, delivery: { ...envelope.delivery, id: crypto.randomUUID() } }), 2);
  assert.equal(w.read('home/user/w.txt'), 'ABAB', 'two distinct writes at the file position');
  console.log('  ok  a delivered write the storage refuses is refused again on its repeat, and leaves nothing');
}

{
  // Retention: a receipt answers for at least the retention after it was
  // recorded and is dropped by twice that; its id is then a tombstone, and a
  // repeat is refused as EIO — outcome unknown — never applied again. A
  // process's exit buries its receipts the same way.
  const R = coreConstants.VFS_DELIVERY_RECEIPT_RETENTION_MS;
  assert.equal(R, 3 * coreConstants.VFS_DELIVERY_RETRY_WINDOW_MS);
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const store = new SupervisorDeliveries();
    let applied = 0;
    const apply = () => { applied++; };
    const id = crypto.randomUUID();
    store.deliver(9, id, 'mkdir', apply);
    for (const at of [R - 1, R, 2 * R - 1]) {
      now = 1_800_000_000_000 + at;
      store.deliver(9, id, 'mkdir', apply);
      assert.equal(applied, 1, `a receipt ${at} ms old did not answer`);
    }
    for (const at of [2 * R, coreConstants.VFS_DELIVERY_TOMBSTONE_RETENTION_MS]) {
      now = 1_800_000_000_000 + at;
      assert.throws(() => store.deliver(9, id, 'mkdir', apply), (error) => error.code === 'EIO', `a repeat ${at} ms late was not refused`);
    }
    assert.equal(applied, 1, 'a repeat whose answer was dropped applied again');

    const kept = crypto.randomUUID();
    store.deliver(4, kept, 'mkdir', apply);
    store.forget(4);
    assert.throws(() => store.deliver(4, kept, 'mkdir', apply), (error) => error.code === 'EIO');
    assert.equal(applied, 2, 'a forgotten process\'s mutation applied again');
  } finally {
    Date.now = realNow;
  }
  console.log('  ok  receipts answer for their retention; a later repeat, or one after exit, is EIO and applies nothing');
}

{
  // Tombstones are bounded: a generation fills for its span or up to its
  // limit, whichever comes first, and two are held — never more than twice
  // the limit, and each for at least one whole generation.
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const store = new SupervisorDeliveries({ receiptMs: 10, tombstoneMs: 1_000, tombstoneLimit: 4 });
    const ids = [];
    for (let i = 0; i < 12; i++) {
      ids.push(crypto.randomUUID());
      store.deliver(1, ids[i], 'mkdir', () => undefined);
      now += 20; // every receipt is dropped by the next delivery
      store.deliver(2, crypto.randomUUID(), 'fsSync', () => undefined);
      assert.ok(store.tombstoneCount <= 8, `${store.tombstoneCount} tombstones held against a limit of 2 × 4`);
    }
    let applied = 0;
    const refused = ids.map((id) => {
      try { store.deliver(1, id, 'mkdir', () => { applied++; }); return false; } catch (error) { return error.code === 'EIO'; }
    });
    // The newest are still refused; the oldest, pushed out by the limit, are not.
    assert.deepEqual(refused.slice(-2), [true, true]);
    assert.equal(refused[0], false, 'the limit held no bound');

    // Nothing buried for two whole spans: those tombstones go, and the id is
    // a stranger again — the bound the guarantee is stated against.
    const late = crypto.randomUUID();
    store.deliver(3, late, 'mkdir', () => undefined);
    now += 20;
    store.deliver(3, crypto.randomUUID(), 'mkdir', () => undefined);
    assert.throws(() => store.deliver(3, late, 'mkdir', () => undefined), (error) => error.code === 'EIO');
    now += 2_000;
    let again = 0;
    store.deliver(3, late, 'mkdir', () => { again++; });
    assert.equal(again, 1, 'a tombstone outlived two idle spans');
    assert.ok(store.tombstoneCount <= 8);
  } finally {
    Date.now = realNow;
  }
  console.log('  ok  tombstones are bounded by count and time, two generations deep');
}

{
  // The reviewer's stall case, end to end: attempt 1 applies a position-
  // relative write and its reply is lost; the retry is sent at once but the
  // session runs it only after a 30 s stall, when the answer has aged out.
  // It is refused as EIO — the file keeps one copy — where it was applied
  // twice. A retry that runs inside the retention still gets the answer.
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const w = world();
    const { pid, rpc } = w.process();
    const handle = await rpc.fsOpen('/home/user/wheel.py', { write: true, create: true, truncate: true });
    w.faults.push({ kind: 'lost-reply' }, { stall: () => { skew += 30_000; } });
    await assert.rejects(rpc.fsWrite(handle.id, null, enc.encode('member.')), (error) => /EIO/.test(error.message) && /outcome is unknown/.test(error.message));
    assert.equal(w.read('home/user/wheel.py'), 'member.', 'the stalled retry applied the write again');
    assertOneDelivery(w.of(pid).filter((arrival) => arrival.op === 'fsWrite'), 'fsWrite', 2);

    w.faults.push({ kind: 'lost-reply' }, { stall: () => { skew += coreConstants.VFS_DELIVERY_RECEIPT_RETENTION_MS - 1_000; } });
    assert.equal(await rpc.fsWrite(handle.id, null, enc.encode('next.')), 5);
    assert.equal(w.read('home/user/wheel.py'), 'member.next.');
  } finally {
    Date.now = realNow;
  }
  console.log('  ok  a retry the session runs after a stall past the retention is EIO, never a second write');
}

{
  // An answer is plain data or it is refused where it enters the store —
  // after the mutation applied, so the refusal is what every repeat meets.
  const store = new SupervisorDeliveries();
  const id = crypto.randomUUID();
  let applied = 0;
  const live = () => { applied++; return supervisorDeliveryAnswer({ id: 3, stream: new Map() }); };
  assert.throws(() => store.deliver(9, id, 'fsOpen', live), /plain data/);
  await assert.rejects(async () => store.deliver(9, id, 'fsOpen', live).answer, /plain data/);
  assert.equal(applied, 1);
  assert.deepEqual(await supervisorDeliveryAnswer(Promise.resolve({ before: 1, after: 2 })), { before: 1, after: 2 });
  await assert.rejects(async () => supervisorDeliveryAnswer(Promise.resolve(() => {})), /plain data/);
  console.log('  ok  only plain answers are recorded; any other is a failure every repeat meets');
}

{
  // fsWriteRange is served natively now, and takes the byte shapes the
  // routed _rpcFsWriteRange took; anything else is EINVAL, not a silent
  // zero-length write.
  const w = world();
  const { pid } = w.process();
  const { host } = w.session;
  await host.supervisorOp({ op: 'writeFile', args: ['/home/user/shapes.bin', 'xxxxxxxx'], pid });
  const bytes = enc.encode('AB');
  const shapes = [
    ['Uint8Array', bytes],
    ['ArrayBuffer', bytes.slice().buffer],
    ['DataView', new DataView(enc.encode('zAB').buffer, 1, 2)],
    ['Uint16Array', new Uint16Array(bytes.slice().buffer)],
    ['number[]', [65, 66]],
    ['Buffer JSON', { type: 'Buffer', data: [65, 66] }],
  ];
  for (const [label, value] of shapes) {
    await host.supervisorOp({ op: 'writeFile', args: ['/home/user/shapes.bin', 'xxxxxxxx'], pid });
    await host.supervisorOp({ op: 'fsWriteRange', args: ['/home/user/shapes.bin', 3, value], pid });
    assert.equal(w.read('home/user/shapes.bin'), 'xxxABxxx', `${label}: not written as the routed op wrote it`);
  }
  for (const garbage of ['AB', 42, null, { data: 'AB' }]) {
    await assert.rejects(host.supervisorOp({ op: 'fsWriteRange', args: ['/home/user/shapes.bin', 3, garbage], pid }), /EINVAL/);
  }
  assert.equal(w.read('home/user/shapes.bin'), 'xxxABxxx');
  console.log('  ok  fsWriteRange takes every byte shape the routed op took, and refuses the rest as EINVAL');
}

console.log('supervisor-rpc-write-delivery: ok');
