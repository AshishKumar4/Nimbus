#!/usr/bin/env bun
// A resident launch must stop holding its module map before the facet boots
// on it.
//
// The one-shot path has scoped its map to the load since 14046a83. `spawnNode`
// — the path every attached-TTY npm bin takes, which is how a real agentic CLI
// starts — never did: it kept the raw cells, the manifest, the metadata and the
// generated source alive across `_startResidentProcess`. For pi that is 22.9 MB
// of program held a second time, and a bare `pi` launch reset the session
// isolate with exceededMemory. An isolate reset tears the terminal WebSocket
// down with no exit frame, which is the dead screen reading
// "[process terminal closed]".
//
// Three properties:
//   1. the release is total, and marks the state, so a launch that tried to
//      generate a second map throws instead of quietly building one with no
//      program in it;
//   2. `spawnNode` performs it, and before it starts the resident process —
//      releasing after the boot would keep the copy alive for exactly the
//      window that was killing the isolate;
//   3. a real resident launch reaches its facet with the program in the image
//      store, so the frame genuinely has nothing left to hold.
//
// (2) is checked against the source. Retention has no runtime observable —
// nothing outside the launch frame can hold a reference to the state it built
// — and an ordering invariant with no observable is exactly what drifts. Same
// reason facet-vfs-cursor-seeded.mjs checks generated bodies for the cursor
// seed rather than waiting for a session to lose its resident set.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FacetManager,
  generateLongRunningNodeCode,
  releaseResidentLaunchSources,
} from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FACET_IMAGE_DIR } from '../../packages/worker/src/loaders/process-fabric.ts';

const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

// ── 1. the release is total, and is marked ────────────────────────────────
{
  const state = {
    bundle: { 'home/user/a.js': 'module.exports = 1;\n' },
    manifest: { 'home/user': ['a.js'] },
    metadata: { 'home/user/a.js': { size: 20 } },
    cursor: { epoch: 'e', rev: 7 },
    reachableCount: 1,
    truncated: false,
  };

  // Generating first is the real order: the map is a total encoding of all
  // three, which is what makes releasing them a pure drop.
  const generated = await generateLongRunningNodeCode('', state, { cred: CRED }, false, '/* shims */');
  assert.ok(generated.code.includes('module.exports = 1;'), 'the map carries the program');

  releaseResidentLaunchSources(state);
  assert.deepEqual(state.bundle, {}, 'cells released');
  assert.deepEqual(state.manifest, {}, 'manifest released');
  assert.deepEqual(state.metadata, {}, 'metadata released');
  assert.deepEqual(state.cursor, { epoch: 'e', rev: 7 },
    'the one field the rest of the launch reads survives the release');

  await assert.rejects(
    () => generateLongRunningNodeCode('', state, { cred: CRED }, false, '/* shims */'),
    /released after its module map was generated/,
    'a released state refuses a second map rather than silently building an empty one',
  );
}

// ── 2. the launch releases, and does it before the boot ───────────────────
{
  const source = readFileSync(
    new URL('../../packages/worker/src/facets/manager.ts', import.meta.url), 'utf8',
  );
  const start = source.indexOf('  private async _residentLaunchBody(');
  assert.ok(start > 0, 'the resident launch body is where a resident process is built');
  const body = source.slice(start, source.indexOf('\n  /**', start + 10));

  const released = body.indexOf('releaseResidentLaunchSources(');
  assert.ok(
    released > 0,
    'the launch releases the sources its module map was built from; without this the '
    + 'coordinator carries a second copy of the program (22.9 MB for pi) while the facet boots, '
    + 'and the session isolate is reset with exceededMemory',
  );
  const booted = body.indexOf('this._startResidentProcess(');
  assert.ok(booted > 0, 'the launch starts the resident process');
  assert.ok(
    released < booted,
    'the release happens BEFORE the boot — releasing afterwards keeps the copy alive for '
    + 'exactly the window that was resetting the isolate',
  );
}

// ── 3. a real launch reaches its facet by path ────────────────────────────
setCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));

const ctx = createFacetCtx(world, 'resident-launch-release');
const env = {
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(
        readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
        { status: 200 },
      );
    },
  },
};

const manager = new FacetManager(
  ctx, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs);

const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
fs.writeFile(
  'home/user/node_modules/dep/package.json',
  JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
  { mode: 0o644 },
);
fs.writeFile('home/user/node_modules/dep/lib/index.js', 'module.exports = 1;\n', { mode: 0o644 });
for (let i = 0; i < 30; i++) {
  fs.writeFile(`home/user/node_modules/dep/lib/mod${i}.js`, `module.exports = ${i};\n`, { mode: 0o644 });
}

const spawned = await manager.spawnNode("require('dep');", {
  filename: '/home/user/run.js',
  cwd: '/home/user',
  command: 'dep-tui',
  attachedTty: true,
});
assert.ok(spawned.pid > 0, 'the resident process spawned');
// An attached-TTY launch hands the facet's lifetime call to waitUntil rather
// than awaiting it, so the boot the module map is built for settles just after
// spawnNode returns.
for (let i = 0; i < 50 && world.configs.size === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(world.configs.size, 1, 'exactly one module map was built for the launch');

// The config the facet boots from is resolved from the image store — the
// by-path members are read back inside the start callback, which is why the
// launch frame does not have to be what holds them.
const [config] = [...world.configs.values()];
assert.equal(config.mainModule, 'worker.js', 'the facet boots the generated entry');
const entrySource = config.modules['worker.js'];
assert.equal(typeof entrySource, 'string', 'the entry resolved to source');
assert.ok(entrySource.includes('module.exports = 1;'), 'the resolved entry is the program');

const images = fs.readdir(FACET_IMAGE_DIR).map((e) => (typeof e === 'string' ? e : e.name));
assert.ok(images.length > 0, 'the launch wrote its map to the image store');
const stored = images.map((name) =>
  new TextDecoder().decode(fs.readFileUncached(`${FACET_IMAGE_DIR}/${name}`)));
assert.ok(
  stored.some((source) => source === entrySource),
  'the bytes the facet booted came from the image store, not from the launch frame',
);

console.log(
  'resident-launch-releases-module-map: OK —'
  + ` ${images.length} image(s) in the store, entry ${entrySource.length} chars`,
);
