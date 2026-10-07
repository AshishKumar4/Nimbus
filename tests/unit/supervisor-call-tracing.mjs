#!/usr/bin/env bun
// A supervisor call the platform loses is classified by its trace.
//
// "Network connection lost." on the facet → session hop leaves one question
// per lost call: did the session run it, and what did the repeat meet? The
// trace answers it. SupervisorRPC's span names the process, writer and
// operation id, the attempts, the hedge, the attempt that answered and each
// lost attempt's class; under it, one session span per attempt that arrived
// says what its receipt or read join made of that attempt.
//
// Real code on both sides — SupervisorRPC, the session's supervisor-op
// handler, SupervisorDeliveries, SqliteVFS over SQLite. The tracer stands in
// for `cloudflare:workers`'s: a span is the active parent of what runs
// inside it, so the session's spans nest under the call whose attempt
// reached them, as the platform's RPC spans put them.

import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import {
  openSupervisorDeliveries,
  supervisorDeliveryProps,
} from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { adoptTracing } from '../../packages/platform/src/tracing.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

Math.random = () => 0;

const spans = [];
const active = new AsyncLocalStorage();
// The span shape the adopted tracer hands out: a current runtime's, one from
// before 2026-09-25 (`isTraced` and `setAttribute` only — the pinned
// workerd), or one whose every method throws.
let runtime = 'current';
adoptTracing({
  enterSpan(name, callback) {
    const span = { name, parent: active.getStore(), attributes: {}, exceptions: [] };
    if (runtime === 'current') {
      Object.assign(span, {
        isTraced: true,
        setAttributes(values) {
          for (const [key, value] of Object.entries(values)) if (value !== undefined) this.attributes[key] = value;
          return this;
        },
        recordException(exception) { this.exceptions.push(exception); },
      });
    } else if (runtime === 'before-2026-09-25') {
      Object.assign(span, { isTraced: true, setAttribute(key, value) { this.attributes[key] = value; } });
    } else {
      const broken = () => { throw new TypeError('span method broken'); };
      Object.assign(span, { isTraced: true, setAttribute: broken, setAttributes: broken, recordException: broken });
    }
    spans.push(span);
    return active.run(span, () => callback(span));
  },
});

const dropped = () => Object.assign(new Error('Network connection lost.'), { retryable: true });
const childrenOf = (span) => spans.filter((child) => child.parent === span);

/** A session instance, a SUPERVISOR binding it minted for one process, and the platform between them. */
function world() {
  const harness = createSqliteVfsTestHarness();
  const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  const open = () => {
    const ctx = {};
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const processes = new SessionProcessSupervisor();
    const host = { sqliteFs: vfs, processes, ensureSqliteFs() {}, supervisorDeliveries: openSupervisorDeliveries(ctx) };
    attachSupervisorOps(host, buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem: new ProcessFiles(vfs) })));
    return { ctx, host, processes };
  };
  const w = { session: open(), faults: [], restart() { w.session = open(); } };
  const env = {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get: () => ({
        async supervisorOp(sent) {
          const envelope = structuredClone(sent);
          const fault = w.faults.shift();
          if (fault === 'lost-request') throw dropped();
          const answer = await w.session.host.supervisorOp(envelope);
          if (fault === 'lost-reply') throw dropped();
          return structuredClone(answer);
        },
      }),
    },
  };
  const pid = w.session.processes.spawn('python3', ['python3'], '/home/user').pid;
  const { hostIncarnation } = supervisorDeliveryProps(w.session.ctx);
  w.pid = pid;
  w.rpc = new SupervisorRPC({ props: { doId: 'session', pid, writerId: 'writer-1', hostIncarnation } }, env);
  return w;
}

// ── A write whose reply was lost: applied once, the repeat answered from its receipt ──

{
  spans.length = 0;
  const w = world();
  w.faults.push('lost-reply');
  await w.rpc.writeFile('/home/user/a.txt', 'hello');
  const [call] = spans.filter((span) => span.name === 'nimbus.supervisor.deliver');
  assert.ok(call, 'the write was not traced');
  assert.equal(call.parent, undefined);
  assert.equal(call.attributes['nimbus.op'], 'writeFile');
  assert.equal(call.attributes['nimbus.pid'], w.pid);
  assert.equal(call.attributes['nimbus.writer_id'], 'writer-1');
  assert.equal(call.attributes['nimbus.session_do'], 'session');
  assert.equal(call.attributes['do_call.attempts'], 2);
  assert.equal(call.attributes['do_call.answered_by'], 2);
  assert.equal(call.attributes['do_call.outcome'], 'answered');
  assert.deepEqual(call.exceptions.map((exception) => exception.code), ['connection_lost']);
  const sessionSide = childrenOf(call);
  assert.deepEqual(sessionSide.map((span) => span.name), ['nimbus.session.deliver', 'nimbus.session.deliver']);
  assert.deepEqual(
    sessionSide.map((span) => span.attributes['nimbus.receipt']),
    ['applied', 'replayed'],
    'the session side does not say the lost reply ran and its repeat met the receipt',
  );
  for (const span of sessionSide) {
    assert.equal(span.attributes['nimbus.operation_id'], call.attributes['nimbus.operation_id'], 'the two sides name different operations');
    assert.equal(span.attributes['nimbus.pid'], w.pid);
  }
  console.log('  ok  a lost reply: caller span retried once, session spans applied then replayed');
}

// ── A write whose request was lost: the session saw only the repeat ──

{
  spans.length = 0;
  const w = world();
  w.faults.push('lost-request');
  await w.rpc.writeFile('/home/user/b.txt', 'hello');
  const [call] = spans.filter((span) => span.name === 'nimbus.supervisor.deliver');
  assert.equal(call.attributes['do_call.answered_by'], 2);
  assert.deepEqual(childrenOf(call).map((span) => span.attributes['nimbus.receipt']), ['applied']);
  console.log('  ok  a lost request: one session span, applied by the repeat');
}

// ── A write that reached a restarted session: refused, and recorded as refused on both sides ──

{
  spans.length = 0;
  const w = world();
  w.restart();
  await assert.rejects(w.rpc.writeFile('/home/user/c.txt', 'hello'), /ESTALE/);
  const [call] = spans.filter((span) => span.name === 'nimbus.supervisor.deliver');
  assert.equal(call.attributes['do_call.outcome'], 'callee_error');
  assert.equal(call.attributes['do_call.answered_by'], 1);
  assert.match(call.exceptions.at(-1)?.message ?? '', /ESTALE/, "the caller span does not carry the session's refusal");
  const [refused] = childrenOf(call);
  assert.equal(refused.name, 'nimbus.session.deliver');
  assert.equal(refused.attributes['nimbus.receipt'], undefined, 'a refused delivery reports a receipt');
  assert.equal(refused.exceptions[0]?.code, 'ESTALE', 'the session span does not record why it refused');
  console.log('  ok  a restarted session: ESTALE recorded on the session span and the caller span');
}

// ── Reads: an attempt that arrives while the first is served joins it ──

{
  spans.length = 0;
  const w = world();
  const envelope = { op: 'stat', args: ['/home/user'], pid: w.pid, readId: crypto.randomUUID() };
  await Promise.all([w.session.host.supervisorOp(envelope), w.session.host.supervisorOp(envelope)]);
  const reads = spans.filter((span) => span.name === 'nimbus.session.read');
  assert.deepEqual(reads.map((span) => span.attributes['nimbus.read.joined']), [false, true]);
  assert.deepEqual(reads.map((span) => span.attributes['nimbus.read_id']), [envelope.readId, envelope.readId]);

  spans.length = 0;
  await w.rpc.stat('/home/user');
  const [call] = spans.filter((span) => span.name === 'nimbus.supervisor.read');
  assert.match(call.attributes['nimbus.read_id'], /^[0-9a-f-]{36}$/);
  assert.equal(call.attributes['do_call.hedges'], 0);
  assert.equal(childrenOf(call)[0]?.attributes['nimbus.read_id'], call.attributes['nimbus.read_id']);
  console.log('  ok  reads: a repeat joins the read in flight; both sides name one read id');
}

// ── Telemetry never changes an outcome ──
// Under a runtime whose span lacks the 2026-09-25 methods, and one whose span
// methods throw, every call answers exactly as it does untraced: the value,
// the refusal's code, the receipt that stops a repeat applying twice, and
// the mutation's effect — and nothing is left pending.

/** `promise`, or a loud failure if it has not settled in 2 s: a hang is the bug. */
async function settles(promise, label) {
  let timer;
  const hung = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still pending after 2 s`)), 2000);
  });
  try { return await Promise.race([promise, hung]); } finally { clearTimeout(timer); }
}

for (const shape of ['before-2026-09-25', 'throwing']) {
  runtime = shape;
  spans.length = 0;
  const w = world();
  const kernel = () => w.session.host.sqliteFs.as(CRED_KERNEL);

  // A lost reply: the repeat is answered from the receipt, and the write applied once.
  w.faults.push('lost-reply');
  const revision = await settles(w.rpc.writeFile('/home/user/once.txt', 'hello'), `${shape}: writeFile`);
  assert.equal(revision, w.session.host.sqliteFs.revision('home/user/once.txt'), `${shape}: the answer is not the write's revision`);
  assert.equal(new TextDecoder().decode(kernel().readFile('home/user/once.txt')), 'hello');
  const writes = spans.filter((span) => span.name === 'nimbus.session.deliver');
  assert.equal(writes.length, 2, `${shape}: the session did not see both attempts`);

  // Reads answer their value.
  assert.equal(await settles(w.rpc.readFile('/home/user/once.txt'), `${shape}: readFile`), 'hello');
  assert.equal(await settles(w.rpc.exists('/home/user/missing'), `${shape}: exists`), false);

  // A refusal keeps its code; nothing is applied.
  w.restart();
  await assert.rejects(
    settles(w.rpc.writeFile('/home/user/refused.txt', 'x'), `${shape}: refused write`),
    (error) => error.code === 'ESTALE',
  );
  assert.equal(kernel().exists('home/user/refused.txt'), false);

  if (shape === 'before-2026-09-25') {
    // What such a runtime can record, it still does, through setAttribute.
    const [call] = spans.filter((span) => span.name === 'nimbus.supervisor.deliver');
    assert.equal(call.attributes['nimbus.op'], 'writeFile');
    assert.equal(call.attributes['do_call.attempts'], 2);
    assert.deepEqual(writes.map((span) => span.attributes['nimbus.receipt']), ['applied', 'replayed']);
  }
  console.log(`  ok  ${shape} span: answers, refusals, receipts and effects unchanged; nothing hangs`);
}
runtime = 'current';

console.log('ok - supervisor-call-tracing');
