#!/usr/bin/env bun
// Two launches of the same backgrounded server differ only in their pid, and
// the pid is a start argument, not module text: the generated worker is
// content-addressed into the session's image store, so a pid baked into it
// (as NIMBUS_CP_CHILD_PID in the env) gave every restart a new image.
import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const starts = [];
const world = createFacetWorld(() => ({
  async startProcess(args) { starts.push(args); return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
const env = {
  LOADER: world.loader,
  ASSETS: stagedAssets,
};
const manager = new FacetManager(
  createFacetCtx(world, 'resident-image-dedupe'), env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', 1000, 1000);

const code = "require('node:http').createServer((q, r) => r.end('ok')).listen(4501);";
const options = { filename: '/home/user/server.js', cwd: '/home/user', command: 'node server.js' };
const first = await manager.spawnNode(code, options);
const second = await manager.spawnNode(code, options);
assert.notEqual(first.pid, second.pid);
assert.equal(world.boots.length, 2, 'both launches booted');
const [a, b] = world.boots.map((boot) => boot.config.modules['worker.js']);
assert.ok(a.includes('NimbusProcess'), 'the facet booted the generated worker');
assert.equal(a, b, 'the same server launched twice is one worker image');
assert.deepEqual(starts.map((args) => args?.pid), [first.pid, second.pid],
  'each launch is told its own pid in the start payload');
console.log('resident-image-dedupe-pid: ok');
