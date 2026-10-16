#!/usr/bin/env bun
// host-namespace-routing — a workspace host that names its own session
// binding (the acceptance fixture names it WORKSPACES, with
// composeFabric({ hostNamespace })) gets every path that reaches the host
// Durable Object: fan-out peers, a process hosted on a peer, a process's
// SUPERVISOR, a wrangler-dev guest's assets, Durable Object, KV, D1 and R2
// bindings, and the real-Vite resident's HMR relay. Each runs here as it
// ships, against an env with no NIMBUS_SESSION at all, and must reach the
// host it names, for the identity it was minted for, and answer.
//
// Why: bindings.ts, fanout.ts, process-host.ts and real-vite-hmr.ts once
// read env.NIMBUS_SESSION while SupervisorRPC alone used the composed
// namespace: a host that renamed the binding got a supervisor that answered
// and a fan-out that refused.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { facetTaskSource } from '../../packages/core/src/runtime/facet-task.ts';
import { Fanout } from '../../packages/fabric/src/fanout.ts';
import { DO_DYNAMIC_WORKER_LIMIT } from '../../packages/fabric/src/budgets.ts';
import { adoptCtxExports, composeFabric, hostNamespace } from '../../packages/fabric/src/composition.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { NimbusAssetsRPC, NimbusDurableObjectNamespace, NimbusKVNamespace, NimbusD1Binding, NimbusR2Bucket } = await import('../../packages/fabric/src/bindings.ts');
const { CirrusHmrRPC } = await import('../../packages/worker/src/facets/real-vite-hmr.ts');
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

// The facet harness, imported below, composes the supervisor entrypoint as
// the real worker does; it keeps this namespace.
composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES' });
assert.equal(hostNamespace(), 'WORKSPACES');
const { createFacetWorld, createProcessHost } = await import('./lib/facet-host-harness.mjs');

/**
 * A WORKSPACES namespace whose hosts record every envelope they are asked
 * to dispatch (by host name) and answer each op as `answer` does. There is
 * no NIMBUS_SESSION beside it: reaching for the literal name fails.
 */
function workspaces(answer = () => null) {
  const asked = [];
  const namespace = {
    idFromName: (name) => ({ toString: () => name, name }),
    idFromString: (id) => ({ toString: () => id, name: id }),
    get: (id) => ({
      async supervisorOp(envelope) {
        // As Workers RPC delivers it: undefined members are not sent.
        asked.push(JSON.parse(JSON.stringify({ host: id.name, ...envelope })));
        return answer(envelope);
      },
    }),
  };
  return { env: { WORKSPACES: namespace }, asked };
}

const RUN_AS = { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 };

// ── Fan-out: peers dispatched through the composed namespace ──────────────
{
  const seen = [];
  const env = {
    LOADER: { get() { return {}; } },
    WORKSPACES: {
      idFromName(name) { return { toString: () => name, name }; },
      idFromString(id) { return { toString: () => id, name: id }; },
      get(id) {
        return {
          async supervisorOp(envelope) {
            const [, args] = envelope.args;
            seen.push({ peer: id.name, count: args.length });
            return { results: args.map((value) => ({ ok: true, value })) };
          },
        };
      },
    },
  };
  const pool = new Fanout(env, { id: { toString: () => 'host-namespace-test-do' }, waitUntil() {} }, { network: ISOLATE_NETWORK, tag: 'ns-test', omitSupervisor: true });
  // Wider than the coordinator's Dynamic Worker budget, so it shards.
  const width = DO_DYNAMIC_WORKER_LIMIT + 1;
  const results = await pool.submitMany(Array.from({ length: width }, (_, i) => ({ key: `t-${i}`, args: i })), facetTaskSource('(x) => x'));
  assert.deepEqual(results, Array.from({ length: width }, (_, i) => i), 'every task answered through the composed namespace');
  assert.ok(seen.length > 0 && seen.reduce((n, s) => n + s.count, 0) === width, `the peer shards ran on WORKSPACES hosts: ${JSON.stringify(seen)}`);
  console.log('  ok  Fanout: shards dispatched to WORKSPACES peers');
}

// ── A process's SUPERVISOR, and the real-Vite resident's HMR relay ────────
{
  const { env, asked } = workspaces((envelope) => (envelope.op === 'hmrNextEvent' ? [] : envelope.op === 'exists' ? true : null));
  const supervisor = new SupervisorRPC({ props: { doId: 'host-a', pid: 7, bindingKind: 'process', writerId: 'run-7' } }, env);
  assert.equal(await supervisor.exists('/home/user/x'), true);
  const hmr = new CirrusHmrRPC({ props: { doId: 'host-a' } }, env);
  assert.deepEqual(await hmr.hmrNextEvent(1), []);
  await hmr.hmrSend('client', 'update');
  assert.deepEqual(asked.map(({ host, op, pid, run }) => [host, op, pid, run]), [
    ['host-a', 'exists', 7, 'run-7'], ['host-a', 'hmrNextEvent', undefined, undefined], ['host-a', 'hmrRelay', undefined, undefined],
  ]);
  assert.deepEqual(asked.at(-1).args, ['client', 'update']);
  console.log('  ok  SupervisorRPC and CirrusHmrRPC: reach the WORKSPACES host they name');
}

// ── A wrangler-dev guest's bindings ────────────────────────────────────────
{
  const { env, asked } = workspaces((envelope) => ({
    readFileBytes: new TextEncoder().encode('<h1>asset</h1>'),
    kvCall: 'kv answer',
    d1Query: { success: true, results: { queryResults: [] } },
    innerDoCall: 'pong',
  })[envelope.op] ?? null);
  const assets = new NimbusAssetsRPC({ props: { vfsRoot: 'home/run-as/site', assetsDir: 'public', doId: 'host-b', cred: RUN_AS } }, env);
  const served = await assets.fetch(new Request('https://guest.test/'));
  assert.deepEqual([served.status, await served.text()], [200, '<h1>asset</h1>']);
  const durable = new NimbusDurableObjectNamespace({ props: { bindingName: 'COUNTER', supervisorDoId: 'host-b' } }, env);
  assert.equal(await durable.callOn('room', ['ping'], [1]), 'pong');
  const store = (name) => ({ doId: 'host-b', root: 'home/run-as/app', store: name, cred: RUN_AS });
  assert.equal(await new NimbusKVNamespace({ props: store('KV') }, env).get('k'), 'kv answer');
  assert.deepEqual(Object.keys(await new NimbusD1Binding({ props: { doId: 'host-b', root: 'home/run-as/app', store: 'db' } }, env).query({ queries: [{ sql: 'SELECT 1' }] })), ['success', 'results']);
  assert.equal(await new NimbusR2Bucket({ props: store('BUCKET') }, env).head('k'), null);
  const target = (name) => ({ root: 'home/run-as/app', store: name });
  assert.deepEqual(asked.map(({ host, op, args, cred }) => [host, op, args, cred]), [
    ['host-b', 'readFileBytes', ['home/run-as/site/public/index.html'], RUN_AS],
    ['host-b', 'innerDoCall', [{ bindingName: 'COUNTER', id: 'room', path: ['ping'], args: [1] }], undefined],
    ['host-b', 'kvCall', [target('KV'), { method: 'get', key: 'k' }], RUN_AS],
    ['host-b', 'd1Query', [target('db'), [{ sql: 'SELECT 1' }]], undefined],
    ['host-b', 'r2Call', [target('BUCKET'), { method: 'head', key: 'k' }], RUN_AS],
  ]);
  console.log('  ok  assets, Durable Object, KV, D1 and R2 bindings: each reaches the WORKSPACES host for its store, as its identity');
}

// ── A resident process hosted on a peer ────────────────────────────────────
{
  const source = 'export class NimbusProcess {}';
  const { env } = workspaces();
  adoptCtxExports({ SupervisorRPC: (options) => new SupervisorRPC({ props: options.props }, env) });
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('served'); },
  }));
  const host = createProcessHost('peer', world, { readFile: () => new TextEncoder().encode(source) }, { coordDoId: 'host-c', hostBinding: 'WORKSPACES' });
  const boot = { kind: 'code', code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': source } } };
  const hosted = await host.open({ pid: 11, writerId: 'run-11', workerKey: 'renamed-peer', boot, startArgs: {} });
  try {
    await hosted.started;
    assert.ok(host.namesResolved.length > 0, 'the process was placed on a peer found through WORKSPACES');
    assert.equal(world.boots.length, 1, 'and it booted there');
  } finally {
    await hosted.release();
  }
  console.log('  ok  ProcessFabric: a resident hosted on a WORKSPACES peer');
}

console.log('host-namespace-routing: all checks passed');
