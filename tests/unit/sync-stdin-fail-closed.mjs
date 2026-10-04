#!/usr/bin/env bun
// Regressions for replies crossing the session boundary of a stoppable run.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { ReplayJournal } from '../../packages/worker/src/runtime/stop-replay-journal.ts';

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
cases.redirect = async () => {
  const j = journal();
  j.input?.('/same-file');
  await ask(j, 'fsReadRange', new Uint8Array([65]), 'a', ['/same-file', 0, 1]);
  j.stopped(); j.start('b');
  await assert.rejects(ask(j, 'fsReadRange', new Uint8Array([66]), 'b', ['/same-file', 0, 1]), /answered differently/, 'a separate FileHandle read of the redirect is an observation');
};

function outboundRpc(events) {
  return new SupervisorRPC({ props: { doId: 's', pid: 7, writerId: 'a' } }, {
    NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => ({ supervisorOp: async (e) => {
      events.push(e.args);
      if (e.args[0] === 'fetch') return { live: 'ticket' };
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
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.error(new Error('body broke')); } }));
  try {
    let response;
    try { response = await outboundRpc(events).fetch(new Request('http://fixture/error')); await response.text(); } catch (e) { assert.match(e.message, /body broke/); }
    assert.ok(events.some(([op, payload]) => ['fetched', 'fetchBody'].includes(op) && payload.result?.error === 'body broke'), 'a post-headers error answers the journal ticket');
    assert.ok(response, 'headers precede the body error');
  } finally { globalThis.fetch = saved; }
};
for (const [name, test] of Object.entries(cases)) if (!which || which === name) { await test(); console.log('sync-stdin-fail-closed: ' + name + ' ok'); }
