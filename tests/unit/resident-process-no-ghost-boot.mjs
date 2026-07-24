#!/usr/bin/env bun
// A routed request must never boot a SECOND copy of the user's program.
//
// A resident process (`node server.js`, a python/ruby socket server) runs in a
// keyed dynamic worker. Its port is served through a NimbusLoadedEntrypoint
// route stub resolved fresh on each request. If that stub carries the
// program's code, a request arriving after the Worker Loader evicted the entry
// silently boots a SECOND isolate: the user's module scope is evaluated again,
// its side effects re-run, and the request is answered 200 by a process the
// user never started — with its own memory, while the process they did start
// sits idle. Live-reproduced on a local workerd 2026-07-24: after three more
// resident servers were spawned in one session, the first server's port
// answered 200 with a different module-scope boot id.
//
// The invariant, asserted here through FacetManager's public spawn surface:
//   1. spawning a resident process evaluates the program EXACTLY ONCE;
//   2. any number of routed requests evaluate it ZERO further times;
//   3. a request that finds the facet evicted FAILS LOUD — it never boots a
//      replacement and answers from it.
// A "boot" here is a code-carrying load, exactly as it is on the real loader.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
  _rpcAwaitHostedBoot,
  _rpcRouteHostedHttp,
  _rpcCancelHostProcess,
} from '../../packages/worker/src/session/rpc.ts';
import { readFileSync } from 'node:fs';

/**
 * Stands in for the Worker Loader plus the program it runs. Each load of the
 * program's code is one BOOT with a fresh module scope, which is what a real
 * second isolate would give the user.
 */
function makeLoaderWorld() {
  const world = { boots: [], evicted: false };
  const loadedByKey = new Map();
  world.resolve = (key, code) => {
    if (code !== undefined) {
      const boot = { id: `boot-${world.boots.length + 1}`, served: 0 };
      world.boots.push(boot);
      loadedByKey.set(key, boot);
      return boot;
    }
    const running = world.evicted ? undefined : loadedByKey.get(key);
    if (!running) throw new Error(`Nimbus: dynamic worker '${key}' is no longer loaded (evicted?)`);
    return running;
  };
  return world;
}

/**
 * Whatever form the program arrives in — an inline config, a resident-code
 * spec, a staged artifact — carrying it means this stub can BOOT the program.
 * Carrying nothing means it must find the one already running.
 */
const bootSpecOf = (props) => props.code ?? props.residentCode ?? props.stage;

const world = makeLoaderWorld();
const nleProps = [];
setCtxExports({
  SupervisorRPC: (opts) => ({ __supervisor: opts.props }),
  NimbusLoadedEntrypoint: (opts) => {
    nleProps.push(opts.props);
    const props = opts.props;
    return {
      // Both methods resolve in the CALLER's context, as the real entrypoint
      // does — a code-free stub reaches the running program or throws.
      async startProcess() {
        world.resolve(props.key, bootSpecOf(props));
        return { ok: true };
      },
      async handleHttpRequest(request) {
        const boot = world.resolve(props.key, bootSpecOf(props));
        boot.served++;
        return Response.json({ boot: boot.id, served: boot.served, url: new URL(request.url).pathname });
      },
    };
  },
});

// A resident process is scheduled onto a sibling DO, so the invariant is
// asserted across the real peer legs — where the facet is loaded, and where a
// routed request has to find it again.
const peerSelf = { _hostedProcesses: new Map(), _hostedProcessWaiters: new Map() };
const peerStub = {
  _rpcHostProcessProbe: async () => _rpcHostProcessProbe(peerSelf),
  _rpcHostProcess: (boot, opts) => _rpcHostProcess(peerSelf, boot, opts),
  _rpcAwaitHostedBoot: (key) => _rpcAwaitHostedBoot(peerSelf, key),
  _rpcRouteHostedHttp: (key, wire) => _rpcRouteHostedHttp(peerSelf, key, wire),
  _rpcCancelHostProcess: async (key) => _rpcCancelHostProcess(peerSelf, key),
};

const env = {
  NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => peerStub },
  LOADER: {
    load() { throw new Error('a resident process must not be loaded by the DO'); },
    get() { throw new Error('a resident process must not be loaded by the DO'); },
  },
  // spawnNode stages the node shims from ASSETS (integrity-checked) before it
  // boots anything, so serve the real staged artifact.
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
};
const ctx = { id: { toString: () => 'do-test' }, waitUntil: (_p) => {} };
const processes = new SessionProcessSupervisor();
const portRegistry = new PortRegistry();
const fm = new FacetManager(ctx, env, processes, portRegistry, {});

// ── 1. spawning evaluates the user's program exactly once ───────────────────
const spawned = await fm.spawnNode('http.createServer(...).listen(3000)', {
  command: 'node server.js',
  filename: '/home/user/server.js',
  cwd: '/home/user',
  port: 3000,
});
assert.equal(world.boots.length, 1, "spawn evaluates the user's program exactly once");
const firstBoot = world.boots[0].id;

// The route stub must be code-free — this is the property that makes a ghost
// boot impossible rather than merely unlikely.
const routeProps = nleProps.filter((p) => bootSpecOf(p) === undefined);
assert.ok(routeProps.length >= 1, 'a code-free route stub is bound for the process');
assert.ok(
  routeProps.some((p) => p.key === `nimbus-process:do-test:${spawned.pid}`),
  'the code-free stub is keyed on the process, so it resolves THAT running facet',
);

// ── 2. routed requests never evaluate the program again ─────────────────────
for (let i = 0; i < 25; i++) {
  const res = await portRegistry.routeRequest(3000, new Request(`http://s/port/3000/ping?i=${i}`), '/ping');
  assert.equal(res.status, 200, `request ${i} served`);
  const body = await res.json();
  assert.equal(body.boot, firstBoot, `request ${i} was answered by the process the user started`);
  assert.equal(body.url, '/ping', 'the inner path reaches the program unchanged');
}
assert.equal(world.boots.length, 1, '25 routed requests booted nothing — no ghost process');
assert.equal(world.boots[0].served, 25, 'every request landed on the one running program');

// ── 3. an evicted facet fails LOUD instead of booting a replacement ─────────
world.evicted = true;
const afterEviction = await portRegistry.routeRequest(3000, new Request('http://s/port/3000/ping'), '/ping');
assert.equal(afterEviction.status, 502, 'an evicted facet surfaces an error to the caller');
assert.match((await afterEviction.json()).error, /no longer loaded/, 'the error names the real cause');
assert.equal(world.boots.length, 1, 'eviction booted NO replacement — the ghost never happens');

// ── 4b. $PORT is a hint to the program, not a claim on the port ────────────
// The session exports PORT=3000 by default so Express-style scripts find it.
// A long-running spawn must NOT read that as "this process owns 3000", or the
// second server started in a session takes over the first one's port.
{
  const { runFresh } = await import('../../packages/worker/src/runtime/node-runner.ts');
  const owner = portRegistry.get(3000)?.pid;
  await runFresh(fm, 'http.createServer(...).listen(4200)', {
    argv: [], env: { PORT: '3000' }, cwd: '/home/user', filename: '/home/user/c.js',
    command: 'node c.js', forceLongRunning: true,
  });
  assert.equal(portRegistry.get(3000)?.pid, owner,
    'a spawn that merely inherited $PORT did not seize port 3000');
}

// ── 4. a spawn never claims a port it was not asked for ────────────────────
// `runFresh` used to reserve a guessed default (3000) for every long-running
// node invocation, so the second server started in a session took over the
// first one's port: /port/3000 answered from the newest process while the one
// the user started kept running, unreachable. A port a program really binds
// arrives through the http shim's listen() -> SUPERVISOR.registerPort.
{
  const before = portRegistry.getAll().map((e) => `${e.port}:${e.pid}`).sort();
  const second = await fm.spawnNode('http.createServer(...).listen(4200)', {
    command: 'node b.js', filename: '/home/user/b.js', cwd: '/home/user',
  });
  const after = portRegistry.getAll().map((e) => `${e.port}:${e.pid}`).sort();
  assert.deepEqual(after, before, 'a spawn with no requested port reserves nothing');
  const stillA = portRegistry.get(3000);
  assert.ok(stillA && stillA.pid === spawned.pid,
    "port 3000 still belongs to the process that asked for it, not the newest spawn");
  assert.notEqual(second.pid, spawned.pid);
}

console.log('resident-process-no-ghost-boot: ok');
