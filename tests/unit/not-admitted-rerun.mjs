#!/usr/bin/env bun
// A request to a process whose idle host the platform replaced ran nowhere,
// and its caller is not failed for it (Kinu ask 63).
//
// The platform puts a fresh instance in place of an idle resident's facet.
// The next request waits for its watch, which finds the replacement: the
// process is lost (137), and the request, never sent, is refused as
// ProcessNotAdmitted, only once the pid reads exited. Through the session's
// manager and its port route:
//
//   1. a request to the process's port, a POST with its body, runs again,
//      once, on a new process the session starts for it at once (its restart
//      policy 'never'), and answers; the replacement never ran it as the lost
//      process. The new process's own idle host replaced in turn, the next
//      request runs again too: an owed run is not the recovery budget's;
//   2. a request the embedder makes through the process's own facet is
//      refused typed (ProcessNotAdmitted), its pid already exited, for the
//      embedder to run again.
//
// Red before: both requests failed with the loss (ProcessHostLost, a 502 on
// the port), and the lost process's row was released, so nothing ran again.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { reservePort, routeToSessionPort } from '../../packages/worker/src/session/port-capability.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const PORT = 20961;
/** Each instance of a guest: how often a process started on it, and the requests it answered, each with that count. */
const instances = [];
const evaluate = () => {
  const instance = { starts: 0, answered: [] };
  instances.push(instance);
  return {
    async startProcess() { instance.starts++; return { ok: true }; },
    async handleHttpRequest(request) {
      const body = request.body === null ? '' : await request.text();
      instance.answered.push({ path: new URL(request.url).pathname, starts: instance.starts, body });
      return new Response(`instance ${instances.indexOf(instance)} started ${instance.starts}`);
    },
  };
};
const answered = (path) => instances.flatMap((instance, index) => instance.answered.filter((at) => at.path === path).map((at) => ({ index, starts: at.starts, body: at.body })));

const launched = launchManager('not-admitted-rerun', {
  evaluate,
  hooks: {
    requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(launched.vfs, recipe),
  },
});
const { manager, processes, world, ctx, ports } = launched;
// The session, as its port route meets it: a method that reads its own receiver.
const self = {
  ctx,
  manager,
  portRegistry: ports,
  ensureDurableAppOnPort(port) { return this.manager.ensureDurableAppOnPort(port); },
  cirrusReal: null,
  viteDevServer: null,
  _viteShimPort: null,
};
const viaPort = (path, init) => routeToSessionPort(self, PORT, new Request(`https://session.test/port/${PORT}${path}`, init), path, '');
const turns = async () => { for (let i = 0; i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ── 1. through the port ─────────────────────────────────────────────────────
{
  await reservePort(ctx, { owner: 'slate-app', preferredPort: PORT, occupiedPorts: new Set() });
  const { pid } = await manager.spawnWorker('export class NimbusProcess {}', 'slate app', '/home/user', {
    port: PORT, durable: { owner: 'slate-app' },
  });
  const first = await viaPort('/first');
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'instance 0 started 1');
  await turns();
  const [name] = world.liveFacets();
  world.replace(name);
  const replacement = instances.length - 1;

  const again = await viaPort('/after-idle', { method: 'POST', body: 'the payload' });
  const body = await again.text();
  assert.equal(again.status, 200, `the request is answered: ${body}`);
  assert.equal(processes.get(pid)?.state, 'exited', 'the lost process ended');
  assert.equal(processes.get(pid)?.exitCode, 137);
  const served = ports.get(PORT)?.pid;
  assert.ok(served !== undefined && served !== pid, 'a new process serves the port');
  const [ran, ...again2] = answered('/after-idle');
  assert.deepEqual(again2, [], 'it ran once');
  assert.ok(ran.index >= replacement && ran.starts === 1, 'on an instance a new process started: never as the lost process');
  assert.equal(ran.body, 'the payload', 'with its body whole');
  assert.equal(body, `instance ${ran.index} started 1`);

  // The new process's idle host replaced in turn: its row is a re-drive's, past the recovery budget.
  await turns();
  world.replace(world.liveFacets()[0]);
  const third = await viaPort('/after-idle-again');
  assert.equal(third.status, 200, `the next request is answered too: ${await third.text()}`);
  assert.notEqual(ports.get(PORT)?.pid, served, 'by another new process');
  console.log('  [1] a request to the port of a process whose idle host was replaced runs once on a new process, body and all, and again after the next');
}

// ── 2. through the process's own facet ──────────────────────────────────────
{
  const spawned = await manager.spawnWorker('export class NimbusProcess {}', 'private slate', '/home/user', {});
  for (const instance of instances) instance.answered.length = 0;
  const first = await spawned.facet.fetch(new Request('https://worker.local/first'));
  assert.equal(first.status, 200);
  // Read whole: the request is done, and the process sits idle.
  await first.text();
  await turns();
  const name = world.liveFacets().find((facet) => !facet.startsWith('app-slot-'));
  world.replace(name);
  let stateAtRefusal;
  await assert.rejects(
    spawned.facet.fetch(new Request('https://worker.local/after-idle')).catch((error) => {
      stateAtRefusal = processes.get(spawned.pid)?.state;
      throw error;
    }),
    (error) => error.name === 'ProcessNotAdmitted' && error.pid === spawned.pid,
    'the embedder is told the request ran nowhere',
  );
  assert.equal(stateAtRefusal, 'exited', 'and the pid had ended when it was told');
  assert.deepEqual(answered('/after-idle'), [], 'it ran nowhere');
  console.log('  [2] the embedder\'s own request is refused typed, after the pid ended');
}

console.log('not-admitted-rerun: a request the replaced host never took runs again on the port, and is refused typed to the embedder');
