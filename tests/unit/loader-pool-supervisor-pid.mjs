#!/usr/bin/env bun
//
// Regression: npm install dispatches its write facets through IsolatePool,
// which mints the SUPERVISOR binding the facet uses for writeBatchStream. S2a's
// SupervisorRPC._pid() now rejects pid <= 0, so the pool's historical hardcoded
// `pid: 0` broke every install ("missing or invalid process pid in props").
// The pool must thread a caller-supplied `supervisorPid` into props.pid so the
// supervisor derives the invoking process's write credential. Pools whose facets
// touch only cache/registry RPCs (npm resolve, pre-bundle) never call _pid() and
// keep the 0 default.

import assert from 'node:assert/strict';

import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';
import { adoptCtxExports, composeFabric } from '../../packages/fabric/src/composition.ts';
import { openSupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const boundProps = [];
composeFabric({ supervisorEntrypoint: 'SupervisorRPC' });
adoptCtxExports({
  SupervisorRPC(options) {
    boundProps.push(options.props);
    return { [Symbol.dispose]() {} };
  },
});

const env = { LOADER: { get() { return { getEntrypoint() { return {}; } }; } } };
const ctx = { id: { toString: () => 'loader-pid-test' } };

// Every binding carries the route back to this host beside its identity.
const route = { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'NIMBUS_SESSION', hostDispatchMethod: 'supervisorOp' };

// A positive supervisorPid must reach the SUPERVISOR binding props.
boundProps.length = 0;
new IsolatePool(env, ctx, { network: ISOLATE_NETWORK, supervisorPid: 42 });
assert.deepEqual(boundProps, [{ doId: 'loader-pid-test', pid: 42, route, bindingKind: 'infrastructure' }],
  'supervisorPid must be minted into the SUPERVISOR binding props');

// Default (unset) stays 0 — resolve/pre-bundle pools never call _pid().
boundProps.length = 0;
new IsolatePool(env, ctx, { network: ISOLATE_NETWORK,});
assert.deepEqual(boundProps, [{ doId: 'loader-pid-test', pid: 0, route, bindingKind: 'infrastructure' }],
  'absent supervisorPid defaults to 0');

// supervisorDoIdOverride and supervisorPid compose (peer-DO install path).
boundProps.length = 0;
new IsolatePool(env, ctx, { network: ISOLATE_NETWORK, supervisorDoIdOverride: 'coordinator-do', supervisorPid: 7 });
assert.deepEqual(boundProps, [{ doId: 'coordinator-do', pid: 7, route, bindingKind: 'infrastructure' }],
  'supervisorPid composes with supervisorDoIdOverride');

// ── Hibernation-wake regression (the sv-create "process pid 1000001 does
// not exist" failure): a warm loader slot minted in generation 1 must not be
// returned in generation 2 still credentialed to the dead pid. The cache key
// therefore carries the supervisor identity (supDoId short + pid).
{
  const loaderIds = [];
  const loaderEnvs = [];
  const keyedLoader = {
    get(id, cb) {
      loaderIds.push(id);
      // loader.get's callback may be async (pool passes `async () => code`);
      // store a promise of the minted config's env.
      loaderEnvs.push(Promise.resolve(cb()).then((code) => code?.env));
      return { getEntrypoint: () => ({ async execute() { return 'ok'; } }) };
    },
  };
  const keyedCtx = { id: { toString: () => 'loader-pid-test' } };

  // Two pools identical except supervisorPid — generation-1 then
  // generation-2 of the same session.
  const poolG1 = new IsolatePool({ LOADER: keyedLoader }, keyedCtx, {
    network: ISOLATE_NETWORK,
    tag: 'x', concurrency: 1, supervisorPid: 1000001,
  });
  await poolG1.map((v) => v, ['a']);
  const poolG2 = new IsolatePool({ LOADER: keyedLoader }, keyedCtx, {
    network: ISOLATE_NETWORK,
    tag: 'x', concurrency: 1, supervisorPid: 2000001,
  });
  await poolG2.map((v) => v, ['a']);

  assert.equal(loaderIds.length, 2, 'each pool dispatch calls loader.get once');
  assert.notEqual(loaderIds[0], loaderIds[1],
    'different supervisorPid must produce different loader ids (wake can never reuse a stale-pid slot)');
  assert.match(loaderIds[1], /2000001/,
    'generation-2 loader id names its own supervisor pid');

  // The minted worker's env carries the pid it was keyed under.
  const g2Props = boundProps[boundProps.length - 1];
  assert.deepEqual(g2Props, { doId: 'loader-pid-test', pid: 2000001, route, bindingKind: 'infrastructure' },
    'generation-2 pool mints SUPERVISOR with the new pid');
  assert.ok((await loaderEnvs[1])?.SUPERVISOR,
    'the gen-2 worker config carries the SUPERVISOR binding in env');

  // Warm reuse preserved: same identity → same id.
  loaderIds.length = 0;
  const poolG2b = new IsolatePool({ LOADER: keyedLoader }, keyedCtx, {
    network: ISOLATE_NETWORK,
    tag: 'x', concurrency: 1, supervisorPid: 2000001,
  });
  await poolG2b.map((v) => v, ['a']);
  const warmPool = new IsolatePool({ LOADER: keyedLoader }, keyedCtx, {
    network: ISOLATE_NETWORK,
    tag: 'x', concurrency: 1, supervisorPid: 2000001,
  });
  await warmPool.map((v) => v, ['a']);
  assert.equal(loaderIds.length, 2);
  assert.equal(loaderIds[0], loaderIds[1],
    'identical supervisorPid must reuse the loader id (warm slot preserved)');

  await poolG1.dispose(); await poolG2.dispose(); await poolG2b.dispose(); await warmPool.dispose();
}

// ── A host that delivers mutations exactly once names its INSTANCE in the
// binding, and a restarted instance refuses every delivered mutation minted
// by the one before. So the instance is part of the loader key: a warm slot
// from before a restart, keyed by doId and pid alone (which an embedder's
// pid numbering can repeat), would serve the new instance a binding whose
// every mutation it refuses. A binding routed to another actor names none.
{
  const loaderIds = [];
  const keyedLoader = {
    get(id, cb) {
      loaderIds.push(id);
      void Promise.resolve(cb());
      return { getEntrypoint: () => ({ async execute() { return 'ok'; } }) };
    },
  };
  const before = { id: { toString: () => 'loader-pid-test' } };
  const after = { id: { toString: () => 'loader-pid-test' } };
  const incarnations = [openSupervisorDeliveries(before).incarnation, openSupervisorDeliveries(after).incarnation];
  boundProps.length = 0;
  for (const ctx of [before, after]) {
    const pool = new IsolatePool({ LOADER: keyedLoader }, ctx, { network: ISOLATE_NETWORK, tag: 'x', concurrency: 1, supervisorPid: 5 });
    await pool.map((v) => v, ['a']);
    await pool.dispose();
  }
  assert.deepEqual(boundProps, incarnations.map((hostIncarnation) => ({ doId: 'loader-pid-test', pid: 5, route, hostIncarnation, bindingKind: 'infrastructure' })),
    'each instance mints its own incarnation into the binding');
  assert.notEqual(loaderIds[0], loaderIds[1], 'a restarted instance reused the warm slot of the one before');

  boundProps.length = 0;
  new IsolatePool(env, before, { network: ISOLATE_NETWORK, supervisorDoIdOverride: 'coordinator-do', supervisorPid: 7 });
  assert.deepEqual(boundProps, [{ doId: 'coordinator-do', pid: 7, route, bindingKind: 'infrastructure' }],
    'a binding routed to another actor named this instance');

  // A pid-0 pool (esbuild pre-bundle, npm resolve, cp-spawn) can deliver
  // nothing — SupervisorRPC refuses every filesystem mutation of pid 0 — so
  // its binding names no instance and its warm isolate survives a restart.
  loaderIds.length = 0;
  boundProps.length = 0;
  for (const ctx of [before, after]) {
    const pool = new IsolatePool({ LOADER: keyedLoader }, ctx, { network: ISOLATE_NETWORK, tag: 'esbuild-bundle', concurrency: 1 });
    await pool.map((v) => v, ['a']);
    await pool.dispose();
  }
  assert.deepEqual(boundProps, [{ doId: 'loader-pid-test', pid: 0, route, bindingKind: 'infrastructure' }, { doId: 'loader-pid-test', pid: 0, route, bindingKind: 'infrastructure' }],
    'a pid-0 binding named its instance');
  assert.equal(loaderIds[0], loaderIds[1], 'a pid-0 pool lost its warm isolate to a restart');
}

console.log('loader-pool supervisor pid: ok');
