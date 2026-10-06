#!/usr/bin/env bun
// Regressions for replies crossing the session boundary of a stoppable run.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { ReplayJournal } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
} }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const which = process.env.NIMBUS_REPLAY_CASE;
const cases = {};
const journal = () => { const j = new ReplayJournal(() => {}, 80); j.start('a'); return j; };
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
    j.stopped();
    assert.deepEqual(j.observations, { fsAcquire: 1 }, 'journal the joined logical reply exactly once');
    j.start('b');
    const replay = ask('b', replayId), replayHedge = ask('b', replayId);
    await tick(); assert.equal(served, 2, 'the replay hedge also joins rather than consuming another occurrence');
    const notice = j.boundary('b');
    complete(reply); await Promise.all([replay, replayHedge, notice]);
    assert.equal(j.diverged, null);
    // A different read identity is a real extra observation and MUST stray.
    j.stopped(); j.start('c');
    const replayAgain = ask('c', thirdId); await tick(); complete(reply); await replayAgain;
    await assert.rejects(ask('c', extraId), /which the run before it did not ask for there/);
  } finally { j.close(); await ops.dispose(); }
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
