#!/usr/bin/env bun
// A session's launches keep their transform results through one store, opened
// once, until the filesystem or the transform host it is bound to changes.
//
// FacetManager built a new TransformStore per request, and staging an entry's
// learned runtime code asks for one per module: each new store opened again
// (the schema's CREATE TABLE and CREATE INDEX statements, a pragma read, the
// generation lookup) before its single lookup. Red before: two launches of
// six learned modules opened the store twelve times.
import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { runtimeCodeKey } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { TurnBudget } from '../../packages/fabric/src/turn-budget.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { CRED } from './lib/resident-body.mjs';
import { processFiles } from './lib/process-bridge.mjs';

const APP = 'home/user/app';
const MODULES = 6;

// The session's database, which its filesystem and its transform store share.
const disk = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(disk.sql, disk.ctx);
const kernel = vfs.as(CRED_KERNEL);
kernel.mkdir(APP, { recursive: true, mode: 0o755 });
kernel.writeFile(`${APP}/package.json`, JSON.stringify({ name: 'app' }), { mode: 0o644 });
const world = createFacetWorld(() => ({}));
const ctx = createFacetCtx(world, 'transform-store-opened-once');
ctx.storage.sql = disk.sql;
ctx.storage.transactionSync = disk.ctx.storage.transactionSync;
const fm = new FacetManager(ctx, { LOADER: world.loader }, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
const files = processFiles(vfs);
fm.setVfs(vfs, files);

/** A transform host whose rewrite marks its output with `id`, each request counted in `requests`. */
function host(id, requests) {
  return new EsbuildService(undefined, {
    transformHostId: id,
    transformHost: async (batch) => batch.map(({ code }) => {
      requests.push(code);
      return { code: `/* ${id} */\n${code}`, map: '', warnings: [] };
    }),
  });
}

// What earlier runs of an entry recorded: CommonJS modules whose import() is rewritten.
const learning = { code: new Map(), executedModules: [], dataReads: [] };
for (let i = 0; i < MODULES; i++) {
  const entry = { kind: 'module', path: `/${APP}/m${i}.cjs`, text: `module.exports = () => import("./lazy${i}.mjs");\n` };
  learning.code.set(runtimeCodeKey(entry), entry);
}
const launchFs = files.bind({ pid: 7, cred: CRED });
const opened = () => disk.statements.filter((s) => /^\s*CREATE TABLE IF NOT EXISTS nimbus_transform_results\b/.test(s.sql)).length;
const launch = async () => {
  const pacer = new TurnBudget({ nextTurn: async () => {} }, 2_000_000);
  const modules = await fm._stagedRuntimeCode(learning, launchFs, pacer, 'node', null);
  return [...(modules ?? new Map()).values()];
};

const first = [];
fm.setEsbuildService(host('host/1', first));
const cells = await launch();
assert.equal(cells.length, MODULES, 'every learned module is staged');
for (const cell of cells) assert.match(cell, /\/\* host\/1 \*\//, 'as the transform host rewrote it');
assert.equal(first.length, MODULES, 'the first launch transforms each module');
const again = await launch();
assert.deepEqual(again, cells, 'the next launch stages the same code');
assert.equal(first.length, MODULES, 'from the stored results: nothing is transformed again');
assert.equal(opened(), 1, `two launches of ${MODULES} learned modules open the store once, not ${opened()} times`);

// Another transform host is another store, and none of the first one's results.
const second = [];
fm.setEsbuildService(host('host/2', second));
for (const cell of await launch()) assert.match(cell, /\/\* host\/2 \*\//, 'a new host\'s launch runs its own results');
assert.equal(second.length, MODULES, 'which it transforms itself');
assert.equal(opened(), 2, 'through a store opened for it');
await launch();
assert.equal(opened(), 2, 'once');

console.log(`transform-store-opened-once: ${MODULES} learned modules, two hosts, one store each`);
