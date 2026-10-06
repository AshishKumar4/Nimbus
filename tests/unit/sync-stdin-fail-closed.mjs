#!/usr/bin/env bun
// Regressions for replies crossing the session boundary of a stoppable run.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { ReplayJournal } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import { REPLAY_JOURNAL_MAX_ENTRIES, REPLAY_READ_RECEIPT_MAX_BYTES } from '../../packages/worker/src/runtime/stop-replay-contracts.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SupervisorDeliveries, openSupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
} }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const which = process.env.NIMBUS_REPLAY_CASE;
const cases = {};
// The product's stall (REPLAY_STALL_MS, 15 s). An 80 ms stall raced the
// cases' own 20 ms waits, which a loaded machine stretches past it: the
// boundary case's held replay was then diverged and its boundary rejected
// unhandled (CI, 1 in 3; here, 2 in 80 eight at a time on one CPU).
const journal = () => { const j = new ReplayJournal(() => {}); j.start('a'); return j; };
const ask = (j, op, value, run = 'a', args = []) => j.handle(op, args, run, async () => value);

cases.pid = async () => {
  const calls = [];
  const rpc = new SupervisorRPC({ props: { doId: 's', pid: 7, writerId: 'a' } }, {
    NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({ supervisorOp: async (e) => { calls.push(e); return {}; } }) },
  });
  await rpc.cpSpawn({ parentPid: 900, command: 'node' });
  await rpc.cpStdinWrite(8, new Uint8Array([1]));
  await rpc.cpKill(8, 'SIGTERM');
  assert.deepEqual(calls.map((e) => e.pid), [7, 7, 7], 'every operation attributes effects to the bound caller');
  assert.equal(calls[0].args[0].parentPid, 7);
};
cases.acquired = async () => {
  const j = journal();
  await ask(j, 'fsAcquired', { value: [{ data: new Uint8Array([65]), stat: { size: 1 } }] }, 'a', [null, 'fsReadBatch', [{ path: '/outside/config' }]]);
  j.stopped(); j.start('b');
  await assert.rejects(ask(j, 'fsAcquired', { value: [{ data: new Uint8Array([66]), stat: { size: 1 } }] }, 'b', [null, 'fsReadBatch', [{ path: '/outside/config' }]]), /answered differently/);
};
cases.namespace = async () => {
  for (const op of ['fsList', 'fsAcquire']) {
    const j = journal();
    await ask(j, op, { entries: [{ path: '/x', stat: { size: 1 } }], paths: [{ path: '/x', stat: { size: 1 } }] });
    j.stopped(); j.start('b');
    await assert.rejects(ask(j, op, { entries: [{ path: '/x', stat: { size: 2 } }], paths: [{ path: '/x', stat: { size: 2 } }] }, 'b'), /answered differently/);
  }
};
cases.boundary = async () => {
  const j = journal();
  await ask(j, 'stat', { size: 1 }); j.stopped(); j.start('b');
  let finish;
  const replay = j.handle('stat', [], 'b', () => new Promise((r) => { finish = r; }));
  let passed = false;
  const boundary = Promise.resolve(j.boundary('b')).then(() => { passed = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(passed, false, 'fd 0 waits for delivery, not merely reissue');
  finish({ size: 1 }); await replay; await boundary;
  assert.equal(passed, true);
  j.close();
  const ordered = journal();
  await ask(ordered, 'stat', { size: 1 }); ordered.stopped(); ordered.start('b');
  let deliver;
  const observation = ordered.handle('stat', [], 'b', () => new Promise((r) => { deliver = r; }));
  let changed = false;
  const effect = ordered.handle('registerPort', [8080], 'b', async () => { changed = true; });
  const notice = ordered.boundary('b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(changed, false, 'a post-read effect never overtakes its boundary/observations');
  deliver({ size: 1 }); await observation; await notice; await effect;
  assert.equal(changed, true);
  ordered.close();
};
cases.joinedRead = async () => {
  // A transport hedge is another envelope for the SAME read, not a second
  // program observation. Hold the authority's answer so the two envelopes
  // necessarily join; no timer, network latency or scheduler luck is needed.
  const h = createSqliteVfsTestHarness();
  const processes = new SessionProcessSupervisor();
  const pid = processes.spawn('reader', ['reader'], '/').pid;
  const j = new ReplayJournal(() => {}, 1500); j.start('a');
  let complete, served = 0;
  const host = {
    ensureSqliteFs() {}, sqliteFs: new SqliteVFS(h.sql, h.ctx), processes,
    supervisorDeliveries: new SupervisorDeliveries(),
    facetManager: { journalCall: (op, args, _pid, run, dispatch) => j.handle(op, args, run, dispatch) },
    _rpcFsAcquire: () => { served++; return new Promise((resolve) => { complete = resolve; }); },
  };
  const start = (run) => { j.start(run); host.supervisorDeliveries.startReadRun?.(pid, run, {
    maxEntries: REPLAY_JOURNAL_MAX_ENTRIES, maxBytes: REPLAY_READ_RECEIPT_MAX_BYTES,
    recording: () => j.recording, disqualify: (why) => j.disqualify(why),
  }); };
  start('a');
  const ops = buildSessionSupervisorOps(host);
  const args = ['epoch', 0, { namespace: true }];
  const reply = { epoch: 'epoch', rev: 0, paths: [], more: false };
  const ask = (run, readId) => ops.dispatch({ op: 'fsAcquire', args, pid, run, readId });
  const [firstId, replayId, thirdId, extraId] = Array.from({ length: 4 }, () => crypto.randomUUID());
  const tick = async () => { for (let i = 0; i < 20; i++) await null; };
  try {
    const first = ask('a', firstId), hedge = ask('a', firstId);
    await tick(); assert.equal(served, 1, 'two pending transport attempts join one authority read');
    complete(reply); await Promise.all([first, hedge]);
    assert.equal(host.supervisorDeliveries.readsServing, 0);
    assert.equal(host.supervisorDeliveries.readReceipts, 1);
    const settledResend = ask('a', firstId); settledResend.catch(() => {});
    await tick();
    assert.equal(served, 1, 'a resend after settlement reuses the same logical reply, not a second journal occurrence');
    assert.equal(await settledResend, reply, 'the settled resend carries the original answer');
    j.stopped();
    assert.deepEqual(j.observations, { fsAcquire: 1 }, 'journal the joined logical reply exactly once');
    await ops.rewind(pid);
    assert.equal(host.supervisorDeliveries.readReceipts, 0, 'a stopped writer releases its replies before replay');
    assert.equal(host.supervisorDeliveries.readReceiptBytes, 0);
    start('b');
    const replay = ask('b', replayId), replayHedge = ask('b', replayId);
    await assert.rejects(ask('a', firstId), /ESTALE/, 'an earlier run cannot borrow the new run\'s receipt scope');
    await tick(); assert.equal(served, 2, 'the replay hedge also joins rather than consuming another occurrence');
    complete(reply); await Promise.all([replay, replayHedge]);
    const afterSettlement = ask('b', replayId); afterSettlement.catch(() => {}); await tick();
    assert.equal(served, 2, 'a late replay hedge cannot consume another occurrence');
    assert.equal(await afterSettlement, reply);
    await j.boundary('b');
    assert.equal(j.diverged, null);
    // A different read identity is a real extra observation and MUST stray.
    j.stopped(); start('c');
    const replayAgain = ask('c', thirdId); await tick(); complete(reply); await replayAgain;
    await assert.rejects(ask('c', extraId), /which the run before it did not ask for there/);
  } finally { j.close(); host.supervisorDeliveries.endReadRun?.(pid, 'c'); await ops.dispose(); }
};
cases.readReceiptLifetime = async () => {
  const d = new SupervisorDeliveries();
  const options = { maxEntries: REPLAY_JOURNAL_MAX_ENTRIES, maxBytes: REPLAY_READ_RECEIPT_MAX_BYTES,
    recording: () => true, disqualify: (why) => assert.fail(why) };
  d.startReadRun(7, 'a', options);
  const failure = Object.assign(new Error('the read failed'), { code: 'EIO' });
  let calls = 0, admitted = 0;
  const id = crypto.randomUUID();
  const read = () => d.joinRead(7, id, 'stat', () => { admitted++; }, async () => { calls++; throw failure; }, 'a').answer;
  await assert.rejects(read(), (error) => error === failure);
  await assert.rejects(read(), (error) => error === failure, 'a settled failure is retained exactly as a settled value is');
  assert.equal(calls, 1); assert.equal(admitted, 1);
  assert.equal(d.readReceipts, 1); assert.equal(d.readsServing, 0);
  d.startReadRun(7, 'a', options);
  assert.equal(d.readReceipts, 1, 'repeating the same writer activation cannot erase its receipt');
  d.startReadRun(7, 'b', options);
  assert.equal(d.readReceipts, 0); assert.equal(d.readReceiptBytes, 0, 'writer activation replaces the previous scope');
  const fresh = d.joinRead(7, id, 'stat', () => {}, async () => ({ size: 9 }), 'b');
  assert.deepEqual(await fresh.answer, { size: 9 }, 'another run cannot inherit a receipt, even with the same read id');
  assert.throws(() => d.joinRead(7, id, 'lstat', () => {}, async () => null, 'b'), /EINVAL/);
  d.endReadRun(7, 'a'); assert.equal(d.readReceipts, 1, 'a retired writer cannot clear its successor\'s receipts');
  d.forget(7); assert.equal(d.readReceipts, 0); assert.equal(d.readReceiptBytes, 0);
  d.startReadRun(7, 'c', options);
  let deliver;
  const pending = d.joinRead(7, crypto.randomUUID(), 'stat', () => {}, () => new Promise((resolve) => { deliver = resolve; }), 'c').answer;
  assert.equal(d.readsServing, 1);
  d.endReadRun(7, 'c'); deliver({ size: 3 }); await pending;
  assert.equal(d.readsServing, 0); assert.equal(d.readReceipts, 0, 'a late completion cannot resurrect a retired scope');
  // No journal: preserve the old read behavior and common-path memory cost.
  let ordinary = 0;
  const normal = () => d.joinRead(8, id, 'stat', () => {}, async () => ++ordinary, 'ordinary').answer;
  assert.equal(await normal(), 1); assert.equal(await normal(), 2);
  assert.equal(d.readReceipts, 0); assert.equal(d.readReceiptBytes, 0);
};
cases.readReceiptBounds = async () => {
  for (const bound of ['entries', 'bytes']) {
    const j = journal(), d = new SupervisorDeliveries();
    const maxEntries = bound === 'entries' ? 1 : 99, maxBytes = bound === 'bytes' ? 512 : REPLAY_READ_RECEIPT_MAX_BYTES;
    d.startReadRun(7, 'a', { maxEntries, maxBytes, recording: () => j.recording, disqualify: (why) => j.disqualify(why) });
    let calls = 0;
    const firstId = crypto.randomUUID();
    const ask = (id, size) => d.joinRead(7, id, 'stat', () => {}, () => j.handle('stat', ['/config' + size], 'a', async () => { calls++; return { size }; }), 'a').answer;
    assert.deepEqual(await ask(firstId, 1), { size: 1 });
    assert.equal(j.replayable, true);
    assert.deepEqual(await ask(crypto.randomUUID(), 2), { size: 2 }, 'the over-bound run continues normally');
    assert.equal(j.replayable, false, 'the run is disqualified before its over-bound reply is handed out');
    assert.match(j.unreplayable, bound === 'entries' ? /more than 1 retained filesystem read receipts/ : /more than 512 bytes/);
    assert.deepEqual(await ask(firstId, 1), { size: 1 }, 'an earlier receipt is never silently evicted');
    assert.equal(calls, 2); assert.equal(d.readReceipts, 1); assert.ok(d.readReceiptBytes <= maxBytes);
    d.endReadRun(7, 'a'); assert.equal(d.readReceiptBytes, 0); j.close();
  }
  const j = journal(), d = new SupervisorDeliveries();
  d.startReadRun(7, 'a', { maxEntries: 99, maxBytes: 1024, recording: () => j.recording, disqualify: (why) => j.disqualify(why) });
  const huge = new Uint8Array(4096);
  const view = huge.subarray(0, 1);
  const result = d.joinRead(7, crypto.randomUUID(), 'fsReadRange', () => {}, () => j.handle('fsReadRange', [], 'a', async () => view), 'a').answer;
  assert.equal(await result, view);
  assert.equal(j.replayable, false, 'retention accounts the backing buffer, not just its one-byte view');
  assert.match(j.unreplayable, /more than 1024 bytes/);
  assert.equal(d.readReceiptBytes, 0); d.endReadRun(7, 'a'); j.close();
};
cases.readReceiptOwner = async () => {
  const { FacetManager } = await import('../../packages/worker/src/facets/manager.ts');
  const j = new ReplayJournal(() => {}), ctx = {};
  const owner = { ctx, journals: new Map([[7, j]]), stdinTaken: new Map(), outputGates: new Map(),
    processes: { get: () => ({ state: 'running' }) },
    vfs: { activateAppendWriter() {}, revokeAppendWriter() {}, revokeAppendWriters() {} } };
  // The actual manager activation/retirement methods, not a test-owned
  // retention registration, connect the receipt lifetime to the writer.
  FacetManager.prototype._activateProcessVfsWriter.call(owner, 7, 'a');
  const d = openSupervisorDeliveries(ctx);
  const ask = (path, value) => d.joinRead(7, crypto.randomUUID(), 'readFileBytes', () => {},
    () => j.handle('readFileBytes', [path], 'a', async () => value), 'a').answer;
  await ask('/small', new Uint8Array([1]));
  assert.equal(d.readReceipts, 1);
  const large = new Uint8Array(REPLAY_READ_RECEIPT_MAX_BYTES + 1);
  assert.equal(await ask('/large', large), large, 'an over-bound observation continues normally');
  assert.match(j.unreplayable, /REPLAY_READ_RECEIPT_MAX_BYTES=8388608/);
  const resumed = await FacetManager.prototype._resumeStoppedRun.call(owner, { pid: 7 },
    { v: 3, kind: 'stdin', run: 1, out: [] }, 0, 7, { captureOutput: true }, new AbortController().signal, {},
    { accepted: { stdout: '', stderr: '' }, refused: j.unreplayable });
  assert.equal(resumed.exit.exitCode, 1);
  assert.match(resumed.exit.stderr, /ERR_NIMBUS_SYNC_STDIN.*REPLAY_READ_RECEIPT_MAX_BYTES=8388608/,
    'the later stop fails precisely, naming the retention bound');
  FacetManager.prototype.revokeProcessVfsWriters.call(owner, 7, 'a');
  assert.equal(d.readReceipts, 0); assert.equal(d.readReceiptBytes, 0); j.close();
};
cases.redirect = async () => {
  const j = journal();
  j.input?.('/same-file');
  await ask(j, 'fsReadRange', new Uint8Array([65]), 'a', ['/same-file', 0, 1]);
  j.stopped(); j.start('b');
  await assert.rejects(ask(j, 'fsReadRange', new Uint8Array([66]), 'b', ['/same-file', 0, 1]), /answered differently/, 'a separate FileHandle read of the redirect is an observation');
};

function outboundRpc(events, plan = { live: 'ticket' }) {
  return new SupervisorRPC({ props: { doId: 's', pid: 7, writerId: 'a' } }, {
    NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({ supervisorOp: async (e) => {
      events.push(e.args);
      if (e.args[0] === 'fetch') return plan;
      return true;
    } }) },
  });
}
cases.sse = async () => {
  const saved = globalThis.fetch;
  let stream;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { stream = c; c.enqueue(new TextEncoder().encode('data: hello\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const r = await Promise.race([outboundRpc([]).fetch(new Request('http://fixture/sse')), new Promise((_, reject) => setTimeout(() => reject(new Error('headers did not resolve within 1 s')), 1000))]);
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    stream.close(); await r.text();
  } finally { globalThis.fetch = saved; }
};
cases.bodyError = async () => {
  const saved = globalThis.fetch, events = [];
  const original = Object.assign(new TypeError('body broke'), { code: 'EPIPE', cause: new Error('root cause') });
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.error(original); } }));
  try {
    let response;
    try { response = await outboundRpc(events).fetch(new Request('http://fixture/error')); await response.text(); } catch (e) { assert.match(e.message, /body broke/); }
    assert.ok(events.some(([op, payload]) => ['fetched', 'fetchBody'].includes(op) && payload.result?.error === 'body broke'), 'a post-headers error answers the journal ticket');
    assert.ok(response, 'headers precede the body error');
    const result = events.find(([op]) => op === 'fetchBody')[1].result;
    const replay = await outboundRpc([], { ticket: 'replay', replay: {
      status: 200, statusText: 'OK', headers: [], hasBody: true, body: result.body,
      chunks: result.chunks, bodyError: result.error, bodyFailure: result.failure,
    } }).fetch(new Request('http://fixture/error'));
    await assert.rejects(replay.text(), (e) => e instanceof TypeError && e.code === 'EPIPE' && e.cause?.message === 'root cause' && e.stack === original.stack,
      'a replay delivers the whole body error the program saw, not just its message');
  } finally { globalThis.fetch = saved; }
};
for (const [name, test] of Object.entries(cases)) if (!which || which === name) { await test(); console.log('sync-stdin-fail-closed: ' + name + ' ok'); }
