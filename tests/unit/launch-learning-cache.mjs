#!/usr/bin/env bun
// What a run reports drops its command's cached launch only when it taught
// the profile something: a miss the next launch cannot stage (reported every
// run) must not force a rebuild of every launch. A report the session cannot
// store is not swallowed: the process's log says what was lost.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processFiles } from './lib/process-bridge.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}));
const env = {
  LOADER: world.loader,
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)), { status: 200 });
    },
  },
};
const ctx = createFacetCtx(world, 'launch-learning-cache');
const processes = new SessionProcessSupervisor();
const manager = new FacetManager(ctx, env, processes, new PortRegistry(), processHostFor, {});
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', 1000, 1000);

const code = "require('node:http').createServer((q, r) => r.end('ok')).listen(4502);";
const launch = () => manager.spawnNode(code, { filename: '/home/user/server.js', cwd: '/home/user', command: 'node server.js' });
const cachedLaunches = () => manager.prefetchCacheDiag().entries.length;
const exit = async (pid, dataReads) => {
  manager.noteProcessReportedExit(pid, 0, dataReads, { served: new Set(), profileUnread: [] });
  await Promise.all(ctx.waited.splice(0));
};

const first = await launch();
assert.equal(cachedLaunches(), 1, 'a launch is cached');
await exit(first.pid, ['home/user/unstageable.bin']);
assert.equal(cachedLaunches(), 0, 'a report that taught the profile a path drops the cached launch');
const second = await launch();
assert.equal(cachedLaunches(), 1);
await exit(second.pid, ['home/user/unstageable.bin']);
assert.equal(cachedLaunches(), 1, 'the same miss again teaches nothing and keeps the cached launch');

// A store that cannot write: the loss is in the process's own log.
const put = ctx.storage.put;
ctx.storage.put = async (key, value) => {
  if (key.startsWith('launch-profile')) throw new Error('storage write refused');
  return put(key, value);
};
const third = await launch();
await exit(third.pid, ['home/user/another.bin']);
ctx.storage.put = put;
const log = processes.allLogs(third.pid).map((chunk) => chunk.data).join('');
assert.match(log, /not recorded for its next launch: storage write refused/, `the failure reaches the log: ${JSON.stringify(log)}`);
console.log('launch-learning-cache: ok');
