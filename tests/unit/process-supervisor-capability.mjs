#!/usr/bin/env bun
// A one-shot's SUPERVISOR is a capability its host hands it with the call
// that runs it, answered by the host itself. A call on it is no new request
// to the host, so it never becomes the host's front request, whose subrequest
// depth the host's later calls inherit: a shell loop of 50 `node -e 1` failed
// fsList with "Subrequest depth limit exceeded" about 15 in, each run's calls
// arriving through SupervisorRPC a hop deeper.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  RpcTarget: class {},
  WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
}));
const { ProcessSupervisor } = await import('../../packages/worker/src/session/process-supervisor.ts');
const { processes } = await import('../../packages/fabric/src/workerd-facet-host.ts');
const { adoptCtxExports, composeFabric } = await import('../../packages/fabric/src/composition.ts');

const PROPS = { doId: 'session-do', pid: 7, writerId: 'run-1', bindingKind: 'process' };
composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
adoptCtxExports({ SupervisorRPC: ({ props }) => ({ binding: props }) });

// ── 1. Answered by the host's own supervisorOp, as the process, once ───────
{
  const envelopes = [];
  const supervisor = new ProcessSupervisor(PROPS, {}, async (envelope) => {
    envelopes.push(envelope);
    return envelope.op === 'fsList' ? { entries: [], next: null } : undefined;
  });
  await supervisor.fsList(null, 10);
  await supervisor.stdout(new Uint8Array([104]));
  assert.deepEqual(envelopes.map(({ op, pid, run }) => ({ op, pid, run })), [
    { op: 'fsList', pid: 7, run: 'run-1' },
    { op: 'stdout', pid: 7, run: 'run-1' },
  ], 'each call reaches the host once, stamped as the process it was minted for');
  assert.deepEqual(Object.getOwnPropertyNames(supervisor), [], 'nothing of its transport is on it to call');
}

// ── 2. A one-shot is entered by run(request, capability, ended) ───────────
const ctx = { id: { toString: () => 'capability-host' }, waitUntil() {} };
const spec = {
  compatibilityDate: '2026-04-21',
  compatibilityFlags: [],
  mainModule: 'runner.js',
  modules: { 'runner.js': 'export default { fetch() {} };' },
};
function oneShot(run) {
  const loaded = {};
  const env = { LOADER: { load(config) {
    loaded.config = config;
    return {
      getEntrypoint: () => ({ run: (...args) => { loaded.args = args; return run(...args); }, [Symbol.dispose]() {} }),
      [Symbol.dispose]() {},
    };
  } } };
  return { env, loaded };
}
const params = (request) => ({
  pid: 7,
  writerId: 'run-1',
  request,
  code: async () => spec,
  onWriterActivated() {},
});
{
  const capability = { capability: 'one-shot' };
  const { env, loaded } = oneShot(async () => Response.json({ exitCode: 0 }));
  const result = await processes(ctx, env).run(PROPS, () => capability, params(new Request('http://run.local/', { method: 'POST' })), (response) => response.json());
  assert.deepEqual(result, { exitCode: 0 });
  const { config, args } = loaded;
  assert.equal(args[1], capability, 'the program is handed its host\'s capability');
  assert.equal(config.env.SUPERVISOR, undefined, 'and no binding: its calls never come back as requests');
  assert.equal(config.mainModule, 'nimbus-one-shot.js');
  assert.match(config.modules['nimbus-one-shot.js'], /import program from "\.\/runner\.js"/);
  assert.equal(config.modules['runner.js'], spec.modules['runner.js'], 'the program\'s own modules ride unchanged');
  assert.equal(await args[2](), null, 'a run whose call is over is not ended');
}
{
  // A kill ends the run at once, as a fetch carrying the signal did, and the
  // run hears why, to abort itself.
  const { env, loaded } = oneShot(() => new Promise(() => {}));
  const kill = new AbortController();
  const running = processes(ctx, env).run(PROPS, () => ({}), params(new Request('http://run.local/', { method: 'POST', signal: kill.signal })), (response) => response.json());
  while (!loaded.args) await new Promise((resolve) => setTimeout(resolve, 1));
  kill.abort(new Error('killed by Ctrl-C'));
  await assert.rejects(running, /killed by Ctrl-C/);
  assert.match(await loaded.args[2](), /killed by Ctrl-C/);
  assert.equal(loaded.args[0].signal.aborted, false, 'the request crossed without its signal: workerd cannot serialize one');
}
{
  // And while its response is still being read: the run hears the kill until
  // its body is consumed, as a fetch carrying the signal would.
  const { env, loaded } = oneShot(async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
  const kill = new AbortController();
  let reading = false;
  const running = processes(ctx, env).run(PROPS, () => ({}), params(new Request('http://run.local/', { method: 'POST', signal: kill.signal })), (response) => {
    reading = true;
    return response.text();
  });
  while (!reading) await new Promise((resolve) => setTimeout(resolve, 1));
  kill.abort(new Error('killed mid-body'));
  const unheard = new Promise((resolve) => setTimeout(() => resolve('still reading'), 2000));
  await assert.rejects(Promise.race([running, unheard]), /killed mid-body/);
  assert.match(await loaded.args[2](), /killed mid-body/);
}

console.log('a one-shot\'s SUPERVISOR is its host\'s capability, handed with the call that runs it');
