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
//   1. a request to the process's port runs again, once, on a new process
//      the session starts for it at once (its restart policy 'never'), and
//      answers; the replacement never ran it as the lost process;
//   2. a request the embedder makes through the process's own facet is
//      refused typed (ProcessNotAdmitted), its pid already exited, for the
//      embedder to run again.
//
// Red before: both requests failed with the loss (ProcessHostLost, a 502 on
// the port), and the lost process's row was released, so nothing ran again.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { reservePort } from '../../packages/worker/src/session/port-capability.ts';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });
const { routeToSessionPort } = await importWorkerBundle({
  'packages/worker/src/session/port-capability.ts': ['routeToSessionPort'],
});

const PORT = 20961;
/** Each instance of a guest, and the requests each answered as which process. */
const instances = [];
const evaluate = () => {
  const instance = { started: null, answered: [] };
  instances.push(instance);
  return {
    async startProcess(args) { instance.started = args?.pid ?? null; return { ok: true }; },
    async handleHttpRequest(request) {
      instance.answered.push(new URL(request.url).pathname);
      return new Response(`instance ${instances.indexOf(instance)} as pid ${instance.started}`);
    },
  };
};

const launched = launchManager('not-admitted-rerun', {
  evaluate,
  hooks: {
    requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(launched.vfs, recipe),
  },
});
const { manager, processes, world, ctx, ports } = launched;
const self = {
  ctx,
  portRegistry: ports,
  ensureDurableAppOnPort: (port) => manager.ensureDurableAppOnPort(port),
  cirrusReal: null,
  viteDevServer: null,
  _viteShimPort: null,
};
const viaPort = (path) => routeToSessionPort(self, PORT, new Request(`https://session.test/port/${PORT}${path}`), path, '');
const turns = async () => { for (let i = 0; i < 200; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// ── 1. through the port ─────────────────────────────────────────────────────
{
  await reservePort(ctx, { owner: 'slate-app', preferredPort: PORT, occupiedPorts: new Set() });
  const { pid } = await manager.spawnWorker('export class NimbusProcess {}', 'slate app', '/home/user', {
    port: PORT, durable: { owner: 'slate-app' },
  });
  const first = await viaPort('/first');
  assert.equal(first.status, 200);
  assert.match(await first.text(), new RegExp(`as pid ${pid}$`));
  await turns();
  const [name] = world.liveFacets();
  world.replace(name);
  const replacement = instances.at(-1);

  const again = await viaPort('/after-idle');
  const body = await again.text();
  assert.equal(again.status, 200, `the request is answered: ${body}`);
  assert.equal(processes.get(pid)?.state, 'exited', 'the lost process ended');
  assert.equal(processes.get(pid)?.exitCode, 137);
  const served = ports.get(PORT)?.pid;
  assert.ok(served !== undefined && served !== pid, 'a new process serves the port');
  assert.match(body, new RegExp(`as pid ${served}$`), 'and answered it');
  assert.equal(replacement.answered.filter((path) => path === '/after-idle').length, replacement.started === served ? 1 : 0,
    'the replacement ran it only as the new process');
  console.log('  [1] a request to the port of a process whose idle host was replaced runs once on a new process');
}

// ── 2. through the process's own facet ──────────────────────────────────────
{
  const spawned = await manager.spawnWorker('export class NimbusProcess {}', 'private slate', '/home/user', {});
  const first = await spawned.facet.fetch(new Request('https://worker.local/first'));
  assert.equal(first.status, 200);
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
  assert.ok(instances.every((instance) => !instance.answered.includes('/after-idle') || instance.started !== spawned.pid),
    'no instance ran it as the lost process');
  console.log('  [2] the embedder\'s own request is refused typed, after the pid ended');
}

console.log('not-admitted-rerun: a request the replaced host never took runs again on the port, and is refused typed to the embedder');
