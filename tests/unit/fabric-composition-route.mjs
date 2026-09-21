#!/usr/bin/env bun
// The fabric's composition is per isolate, and the route back to the host
// travels with every binding the fabric mints.
//
// Kinu's programmatic host composed `hostNamespace: 'OrchestratorAgent'`
// and its git and npm facets were still refused with "env.NIMBUS_SESSION is
// not a Durable Object namespace": the supervisor entrypoint answered from
// an isolate whose composition was not theirs. Two holes, both closed here:
//
//   1. A second composition with different values was dropped silently
//      (first-write-wins), so an embedder whose module imported another
//      Nimbus entry ran against a host it never named. It now throws,
//      naming both compositions; the same values remain a no-op.
//   2. Entrypoints resolved the host from their own isolate's composition.
//      The route (namespace, dispatch method, entrypoint) is now minted into
//      the binding's props in the host's isolate and read from there, so an
//      isolate that composed nothing, or something else, still answers to
//      the right host.
import assert from 'node:assert/strict';
import {
  composeFabric,
  hostRoute,
  hostNamespace,
  hostDispatchMethod,
  supervisorEntrypoint,
  adoptCtxExports,
} from '../../packages/platform/src/composition.ts';
import { hostNamespaceBinding, hostOpDispatch } from '../../packages/fabric/src/host-dispatch.ts';
import { IsolatePool } from '../../packages/fabric/src/isolate-pool.ts';

// ── 1. A conflicting composition is loud; an identical one is a no-op ──────
{
  assert.equal(hostRoute(), null, 'no composition, no route: a program run without one gets no supervisor binding either');
  const assembler = async () => ({});
  composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', stagedBootAssembler: assembler });
  assert.doesNotThrow(
    () => composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', stagedBootAssembler: assembler }),
    'the same composition again is a no-op',
  );
  assert.throws(
    () => composeFabric({ supervisorEntrypoint: 'SupervisorRPC', stagedBootAssembler: assembler }),
    (error) => {
      assert.match(error.message, /composed twice with different values \(hostNamespace\)/);
      assert.match(error.message, /"hostNamespace":"WORKSPACES"/, 'names the composition that won');
      assert.match(error.message, /"hostNamespace":"NIMBUS_SESSION"/, 'and the one that lost, defaults spelled out');
      return true;
    },
    'a Worker that inherits another entry\'s composition learns it at startup',
  );
  assert.throws(
    () => composeFabric({ supervisorEntrypoint: 'Other', hostNamespace: 'WORKSPACES', stagedBootAssembler: assembler }),
    /different values \(supervisorEntrypoint\)/,
  );
  assert.equal(hostNamespace(), 'WORKSPACES', 'the first composition stands');
  assert.deepEqual(hostRoute(), { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });
  assert.equal(hostDispatchMethod(), 'supervisorOp');
}

// ── 2. The route in a binding's props wins over this isolate's composition ──
{
  const env = {
    WORKSPACES: { idFromName: (n) => n, idFromString: (s) => s, get: () => ({ supervisorOp: async () => 'composed' }) },
    OrchestratorAgent: { idFromName: (n) => n, idFromString: (s) => s, get: () => ({ dispatchNimbus: async () => 'routed' }) },
  };
  const route = { supervisorEntrypoint: 'Sup', hostNamespace: 'OrchestratorAgent', hostDispatchMethod: 'dispatchNimbus' };
  const composedNs = hostNamespaceBinding(env, 'test');
  assert.equal(await hostOpDispatch(composedNs.get('x'), 'test')({ op: 'exists' }), 'composed');
  const routedNs = hostNamespaceBinding(env, 'test', route);
  assert.equal(await hostOpDispatch(routedNs.get('x'), 'test', route)({ op: 'exists' }), 'routed');
  assert.throws(() => hostNamespaceBinding({ WORKSPACES: env.WORKSPACES }, 'SupervisorRPC', route), /env\.OrchestratorAgent must be the Durable Object namespace/);
  // The entrypoint name rides the route too: a stateless hop minting a
  // supervisor binding asks ctx.exports for the route's export.
  const exportsBag = { SupervisorRPC: () => 'composed-factory', Sup: () => 'routed-factory' };
  assert.equal(supervisorEntrypoint(exportsBag)(), 'composed-factory');
  assert.equal(supervisorEntrypoint(exportsBag, route.supervisorEntrypoint)(), 'routed-factory');
}

// ── 3. A pool mints the route into every SUPERVISOR binding it hands out ───
{
  const minted = [];
  adoptCtxExports({ SupervisorRPC: ({ props }) => { minted.push(props); return { props }; } });
  const ctx = { id: { toString: () => 'coordinator-do' }, waitUntil() {} };
  const env = { LOADER: { get() { return {}; } } };
  new IsolatePool(env, ctx, { tag: 'route-test', supervisorPid: 7 });
  assert.deepEqual(minted.at(-1), {
    doId: 'coordinator-do', pid: 7,
    route: { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' },
  }, 'a single-host pool carries this isolate\'s route');
  // A fanout peer mints the COORDINATOR's binding: its doId and its route,
  // whatever the peer's own isolate composed.
  const coordinatorRoute = { supervisorEntrypoint: 'Sup', hostNamespace: 'OrchestratorAgent', hostDispatchMethod: 'dispatchNimbus' };
  new IsolatePool(env, ctx, { tag: 'route-test', supervisorDoIdOverride: 'the-coordinator', supervisorRoute: coordinatorRoute });
  assert.deepEqual(minted.at(-1), { doId: 'the-coordinator', pid: 0, route: coordinatorRoute });
}

console.log('fabric-composition-route: ok');
