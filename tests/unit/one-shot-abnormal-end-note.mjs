#!/usr/bin/env bun
//
// A one-shot node process that ends abnormally says what it may have lost,
// every time (facets/manager.ts, UNSETTLED_END_NOTE).
//
// A one-shot is told a synchronous write succeeded once its client logged
// it, and the client sends only when the program yields. A program that
// acknowledges 5,000 writeFileSync calls without yielding and dies there (out
// of memory) never sent one: the session cannot know they existed. So the
// loss is reported whatever the session saw: exit 1, the run's error, and the
// note naming the bound. Red before: the note was said only for a process
// that had opened a write epoch, and this one never had, so the loss was
// silent.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { UNSETTLED_END_NOTE } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
vfs.as(CRED_KERNEL).mkdir('home/user/app', { recursive: true, mode: 0o755 });
vfs.as(CRED_KERNEL).chown('home/user/app', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);

const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }));
// The one-shot's isolate: it ran the sync loop and died before yielding, so
// nothing of it reached the session; its run answers the platform's death.
let runs = 0;
const env = {
  LOADER: {
    get: world.loader.get,
    load: (code) => (code?.modules?.['reader.js'] ? world.loader.load(code) : {
      getEntrypoint: () => ({
        async fetch() { runs++; throw new Error('Worker exceeded memory limit.'); },
      }),
    }),
  },
  ASSETS: stagedAssets,
};
const ctx = createFacetCtx(world, 'abnormal-end');
const processes = new SessionProcessSupervisor();
processes.setPidBase(PID_GEN_STRIDE);
const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {
  requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); },
  notify: () => {},
  resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
});
manager.setVfs(vfs, processFiles(vfs));

const program = "const fs = require('fs'); for (let i = 0; i < 5000; i++) fs.writeFileSync('/home/user/app/f' + i, ''); console.log('AFTER'); const hog = []; for (;;) hog.push(new Uint8Array(1 << 20));";
for (const captureOutput of [false, true]) {
  const result = await manager.exec(program, {
    filename: '/home/user/app/sync.js', cwd: '/home/user/app', command: 'node sync.js', argv: ['/home/user/app/sync.js'], captureOutput,
  });
  assert.ok(runs > 0, 'the run never reached the isolate');
  assert.equal(result.exitCode, 1, JSON.stringify(result));
  assert.match(result.stderr, /Worker exceeded memory limit/);
  assert.ok(result.stderr.includes(UNSETTLED_END_NOTE), `the loss was not said: ${JSON.stringify(result.stderr)}`);
  assert.equal(result.stdout.includes('AFTER'), false, 'an output after the lost writes was released');
}
assert.match(UNSETTLED_END_NOTE, /an unknown number of the changes it made since it last produced output or flushed may be lost/);
// No bound is named that the client does not enforce (review recheck).
assert.doesNotMatch(UNSETTLED_END_NOTE, /MiB|\d{3,}/);

console.log('one-shot-abnormal-end-note: ok');
process.exit(0);
