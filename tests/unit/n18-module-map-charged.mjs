#!/usr/bin/env bun
// N18: a resident's storage allowance includes its module map, measured on
// the real launch path. The store adopts the map at boot (the process's code),
// so _planResidentData must charge it. That has to hold on the first launch,
// whose build serializes and releases the raw cells (12314b6f), and on a cache
// hit, which never had them.

import assert from 'node:assert/strict';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

const MB = 1024 * 1024;
const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }));
const manager = new FacetManager(
  createFacetCtx(world, 'module-map-charged'),
  { LOADER: { load() { throw new Error('no one-shot runs here'); }, get: world.loader.get.bind(world.loader) } },
  new SessionProcessSupervisor(), new PortRegistry(), processHostFor,
  { requestLaunchTurn: () => { setTimeout(() => { void manager.pumpResidentLaunches(); }, 0); } },
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, processFiles(vfs));
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir('home/user/app', { recursive: true, mode: 0o755 });
for (const dir of ['home', 'home/user', 'home/user/app']) kernel.chown(dir, 1000, 1000);
// A global package: code the launch's map carries, outside what its data plan
// holds (the working tree), so only the map's own charge covers it.
kernel.mkdir('usr/local/lib/node_modules/big', { recursive: true, mode: 0o755 });
const lib = (n) => `module.exports = ${JSON.stringify('x'.repeat(n))}.length;\n`;
kernel.writeFile('usr/local/lib/node_modules/big/a.js', new TextEncoder().encode(lib(MB)));
kernel.writeFile('usr/local/lib/node_modules/big/b.js', new TextEncoder().encode(lib(MB)));
const ENTRY = "require('/usr/local/lib/node_modules/big/a.js'); require('/usr/local/lib/node_modules/big/b.js');";
const spec = { scriptPath: '/home/user/app/server.js', cwd: '/home/user/app', entryCode: ENTRY };
const entry = manager.processes.spawn('node server.js', ['node', 'server.js'], spec.cwd, { cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
const pacer = manager._launchPacer(entry.pid);

for (const launch of ['first launch', 'cache hit']) {
  const vfsState = await manager._buildProcessBundle(entry, spec, pacer);
  const { storageBytes } = await manager._planResidentData(entry, vfsState, spec.cwd, '/home/user', pacer);
  assert.ok(storageBytes >= 2 * MB, `${launch}: the allowance charges the 2 MiB module map (${storageBytes} bytes)`);
}

console.log('n18-module-map-charged: the module map is charged on the first launch and on a cache hit');
