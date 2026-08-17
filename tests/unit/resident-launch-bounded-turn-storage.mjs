#!/usr/bin/env bun
//
// What a launch turn has OUTSTANDING in storage is bounded.
//
// The launch pacer accounts BYTES OF WORK and ends the turn when a chunk's
// worth has been spent, which is what keeps the session's thread and its CPU
// budget available. It is not what the storage layer resets the object over:
// that is what one turn has outstanding, and the image write reported its
// bytes only AFTER writing them — so a single turn put pi's whole 12.5-22.9 MB
// module map into storage in one call and the platform reset the object out
// from under it ("Internal error in Durable Object storage caused object to be
// reset"), measured at ~25% of launches and ~54% under an extra request
// stream. The same signature, from the same cause, is recorded against a
// 45.7 MB single-turn write in vfs/facet-resident-store.ts.
//
// So the property is not "the image is written efficiently", it is "no turn
// writes much" — a bound that must hold however large the image is.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/fabric/src/ctx-exports.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FACET_IMAGE_DIR } from '../../packages/worker/src/loaders/process-fabric.ts';

setCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

/**
 * The bound a turn's storage writes must stay under.
 *
 * One transaction of content (the VFS admits at most MAX_TX_BLOB_BYTES = 1 MiB
 * in place; past that it falls back to copy-on-write) plus the chunk budget
 * the launch is allowed to spend before it must yield. Stated as a plain
 * number rather than recomputed from the module's own constants, so a change
 * that raises either one has to come back through this assertion.
 */
const MAX_TURN_STORAGE_BYTES = 2 * 1024 * 1024;

// Every byte of content this session's SQLite is asked to store, and where the
// turn boundaries fall in that stream.
function meterStorage(harness) {
  const exec = harness.sql.exec.bind(harness.sql);
  const meter = { bytes: 0, turnStart: 0, maxTurnBytes: 0 };
  harness.sql.exec = (query, ...params) => {
    for (const param of params) {
      if (param && typeof param === 'object' && typeof param.byteLength === 'number') {
        meter.bytes += param.byteLength;
      }
    }
    return exec(query, ...params);
  };
  meter.endTurn = () => {
    meter.maxTurnBytes = Math.max(meter.maxTurnBytes, meter.bytes - meter.turnStart);
    meter.turnStart = meter.bytes;
  };
  meter.reset = () => { meter.bytes = 0; meter.turnStart = 0; meter.maxTurnBytes = 0; };
  return meter;
}

const harness = createSqliteVfsTestHarness();
const meter = meterStorage(harness);
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const fs = vfs.as(CRED_KERNEL);

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
const manager = new FacetManager(
  createFacetCtx(world, 'bounded-turn-storage'),
  {
    LOADER: world.loader,
    // A small work budget so the launch yields often; the image write's own
    // bound is what has to hold the turn down, not this.
    NIMBUS_LAUNCH_CHUNK_BYTES: '65536',
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(
          readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
          { status: 200 },
        );
      },
    },
  },
  new SessionProcessSupervisor(),
  new PortRegistry(),
  processHostFor,
  { requestLaunchTurn: () => {
    meter.endTurn();
    setTimeout(() => { void manager.pumpResidentLaunches(); }, 0);
  } },
);
manager.setVfs(vfs);

// A program whose module map is several times the transaction bound — the size
// at which a whole-file write is the thing that takes the object down.
fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
fs.writeFile(
  'home/user/node_modules/dep/package.json',
  JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
  { mode: 0o644 },
);
const MODULES = 128;
fs.writeFile(
  'home/user/node_modules/dep/lib/index.js',
  Array.from({ length: MODULES }, (_, i) => `require('./mod${i}');`).join('\n')
    + '\nmodule.exports = 1;\n',
  { mode: 0o644 },
);
for (let i = 0; i < MODULES; i++) {
  fs.writeFile(
    `home/user/node_modules/dep/lib/mod${i}.js`,
    `module.exports = ${i};\n// ${'p'.repeat(56_000)}\n`,
    { mode: 0o644 },
  );
}

meter.reset();
const spawned = await manager.spawnNode("require('dep');", {
  filename: '/home/user/run.js',
  cwd: '/home/user',
  command: 'big-tui',
  attachedTty: true,
});
assert.ok(spawned.pid > 0, 'the resident process spawned');

for (let i = 0; i < 2000 && world.configs.size === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
meter.endTurn();
assert.equal(world.configs.size, 1, 'the launch built its module map and booted');

const images = fs.readdir(FACET_IMAGE_DIR).map((e) => (typeof e === 'string' ? e : e.name));
const imageBytes = images.reduce((n, name) => n + fs.lstat(`${FACET_IMAGE_DIR}/${name}`).size, 0);

// Without a big image the bound below would hold for free.
assert.ok(
  imageBytes > 3 * MAX_TURN_STORAGE_BYTES,
  `the launch wrote an image worth bounding (${imageBytes} bytes)`,
);

assert.ok(
  meter.maxTurnBytes <= MAX_TURN_STORAGE_BYTES,
  'no single turn of the launch put more than a bounded amount into storage — the platform '
  + 'resets the object over what one turn has outstanding, not over what the launch eventually '
  + `writes (largest turn: ${meter.maxTurnBytes} bytes, image: ${imageBytes} bytes)`,
);

// The bound is a constant, not a fraction: an image several times larger than
// it still crosses one turn's worth at a time.
assert.ok(
  meter.maxTurnBytes < imageBytes / 3,
  'the per-turn cost does not scale with the size of the image',
);

// Slicing must not be bought with rewrites. A slice too large for one
// transaction falls back to copy-on-write, which re-stages every chunk of the
// file already written — quadratic in the image, and invisible except here.
assert.ok(
  meter.bytes < 2 * imageBytes,
  'the sliced write stores each image about once, rather than re-staging what it has already '
  + `written on every slice (stored ${meter.bytes} bytes for ${imageBytes} bytes of image)`,
);

// And the map the facet boots from is still exactly what was generated.
const [config] = [...world.configs.values()];
const entry = config.modules['worker.js'];
assert.ok(
  images.some((name) => new TextDecoder()
    .decode(fs.readFileUncached(`${FACET_IMAGE_DIR}/${name}`)) === entry),
  'a sliced image reassembles to the bytes the launch generated',
);

console.log(
  `resident-launch-bounded-turn-storage: OK `
  + `(image ${imageBytes} bytes, largest turn ${meter.maxTurnBytes} bytes)`,
);
