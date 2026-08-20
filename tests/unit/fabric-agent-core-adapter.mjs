#!/usr/bin/env bun
// The agent-core adapter example: the lifecycle its ShellExecutionBoundary
// (facet.ts:60-154) actually exercises, driven against the example's fabric
// seams. What the boundary relies on: completion settles once, a rejected
// completion is its exit-1 case, confirmTerminated() === false means "still
// deciding" (defer to the timeout arm, never fail), and fence() must close
// the local handle without throwing.

import assert from 'node:assert/strict';
import { ResidentProcessHandle } from '../../packages/fabric/src/process-fabric.ts';
import {
  FabricEnvironmentProvider,
  shellBackendFor,
} from '../../packages/fabric/examples/agent-core-adapter.ts';

function createHandle() {
  let settleBoot, rejectBoot, settleDone;
  const booted = new Promise((res, rej) => { settleBoot = res; rejectBoot = rej; });
  const done = new Promise((res) => { settleDone = res; });
  booted.catch(() => {});
  const kills = { count: 0 };
  const handle = new ResidentProcessHandle({
    done,
    booted: () => booted,
    routeTarget: { handleHttpRequest: async () => new Response('') , handleWebSocketRequest: async () => new Response('') },
    kill: () => { kills.count++; settleDone(); },
    describe: () => 'test',
  });
  return { handle, settleBoot, rejectBoot, settleDone, kills };
}

// ── ShellProcessBackend ──────────────────────────────────────────────────────

// completion carries the exit code out of the lifetime payload.
{
  const { handle, settleBoot } = createHandle();
  const backend = shellBackendFor(handle, (payload) => payload.exitCode);
  settleBoot({ exitCode: 3 });
  assert.equal(await backend.completion, 3);
}

// A host that dies under the process rejects completion — the boundary's
// exit-1 case, so the rejection must surface, not vanish.
{
  const { handle, rejectBoot } = createHandle();
  const backend = shellBackendFor(handle, (payload) => payload.exitCode);
  rejectBoot(new Error('host died'));
  await assert.rejects(() => backend.completion, /host died/);
}

// confirmTerminated: false while nothing was asked; after forceTerminate it
// settles true only once teardown completed. forceTerminate is idempotent.
{
  const { handle, kills } = createHandle();
  const backend = shellBackendFor(handle, () => 0);
  assert.equal(backend.confirmTerminated(), false, 'false means still deciding, never failed');
  backend.forceTerminate();
  backend.forceTerminate();
  assert.equal(kills.count, 1, 'kill is idempotent through the backend too');
  assert.equal(await backend.confirmTerminated(), true, 'true once the process is actually gone');
}

// fence closes the local handle and never throws, even when teardown does.
{
  let settleDone;
  const done = new Promise((res) => { settleDone = res; });
  const handle = new ResidentProcessHandle({
    done,
    booted: () => Promise.resolve({}),
    routeTarget: { handleHttpRequest: async () => new Response(''), handleWebSocketRequest: async () => new Response('') },
    kill: () => { settleDone(); throw new Error('remote cleanup failed'); },
    describe: () => 'test',
  });
  const backend = shellBackendFor(handle, () => 0);
  backend.fence();
  assert.equal(handle.killed, true, 'the local fence still closes this handle');
}

// ── EnvironmentProvider verbs ────────────────────────────────────────────────

{
  const spawned = [];
  const facets = new Map([['session-s1', true]]);
  const cloned = [];
  const provider = new FabricEnvironmentProvider({
    spawnSession: async (request) => {
      const { handle } = createHandle();
      spawned.push({ request, handle });
      return handle;
    },
    ctx: {
      facets: {
        get() { throw new Error('unused'); },
        abort() {},
        delete() {},
        clone(src, dst) { cloned.push([src, dst]); facets.set(dst, true); },
      },
    },
    facetPopulated: (name) => facets.get(name) === true,
    sessionFacetName: (sessionId) => `session-${sessionId}`,
    previewApex: 'nimbus-os.dev',
  });

  const pin = { environmentId: 'e1', environmentRevision: 1, generation: 1, sessionId: 's1' };

  const session = await provider.openSession(pin);
  assert.equal(session.name, 'ready');
  session.value.release();
  assert.equal(spawned[0].handle.killed, true, 'release maps to the handle teardown');

  const snapshot = await provider.createSnapshot({ ...pin, sessionEpoch: 1, snapshotId: 'snap1' });
  assert.deepEqual(snapshot, { name: 'ready', value: 'snapshot-snap1' });
  assert.deepEqual(cloned, [['session-s1', 'snapshot-snap1']]);

  // A snapshot of a session whose facet does not answer as populated must
  // never be 'ready' — an unresolvable clone source silently EMPTIES the
  // destination while reporting success.
  const bad = await provider.createSnapshot({ ...pin, sessionId: 'missing', sessionEpoch: 1, snapshotId: 'snap2' });
  assert.equal(bad.name, 'failed');

  const exposure = { ...pin, sessionEpoch: 1, exposureId: 'x1', port: 3000 };
  const exposed = await provider.exposePort(exposure);
  assert.deepEqual(exposed, { name: 'ready', value: 'https://3000--s1.nimbus-os.dev/' },
    'hostname-per-port, no rewriting');
  assert.deepEqual(await provider.inspectExposure(exposure), exposed);
  assert.deepEqual(await provider.revokeExposure(exposure), { name: 'succeeded' });
  assert.deepEqual(await provider.inspectExposure(exposure), { name: 'absent' });
}

console.log('ok - fabric-agent-core-adapter (shell backend lifecycle, provider verbs, clone honesty)');
