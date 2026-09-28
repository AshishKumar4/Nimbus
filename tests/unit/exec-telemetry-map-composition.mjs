#!/usr/bin/env bun
/**
 * The exec record has to say what the module map is MADE OF, not only how big
 * it is.
 *
 * A total on its own points at nothing. `pi --version` was diagnosed as a
 * snapshot REBUILD on the strength of `bundleMs` — which workerd's frozen
 * clock reports as 0 once the VFS reads are warm — while the seconds actually
 * sat in `runMs`, a fresh isolate taking a 23 MB map. Naming the part of the
 * total that is the bundle is what makes the next such question answerable
 * from the record instead of from a guess.
 *
 * The map is the bundle plus the fixed runner and shims: the namespace a
 * process boots on is listed at boot, never shipped, so a tree's files that
 * nothing requires cost the map nothing (CUTOVER #13). The part is checked
 * against the total it decomposes, so it cannot drift into measuring
 * something else and still look plausible.
 */

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
import { readExecTelemetry, resetExecTelemetry } from '../../packages/worker/src/facets/exec-telemetry.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';

process.env.NIMBUS_DIAG_EXEC = '1';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

const env = {
  LOADER: {
    load() {
      return {
        getEntrypoint: () => ({
          async fetch() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); },
        }),
      };
    },
    get() { throw new Error('unused'); },
  },
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
  createFacetCtx(createFacetWorld(() => ({})), 'exec-telemetry-composition'),
  env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs, new ProcessFiles(vfs));

// A project with a dependency and a sibling tree, so all three parts are
// non-empty: the bundle carries the required module, the manifest enumerates
// the directories, and the metadata describes what the manifest named.
const fs = vfs.as(CRED_KERNEL);
fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
fs.writeFile(
  'home/user/node_modules/dep/package.json',
  JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
  { mode: 0o644 },
);
fs.writeFile('home/user/node_modules/dep/lib/index.js', 'module.exports = 1;\n', { mode: 0o644 });
for (let i = 0; i < 40; i++) {
  fs.writeFile(`home/user/node_modules/dep/lib/unused${i}.js`, '// nothing requires this\n', { mode: 0o644 });
}

resetExecTelemetry();
const result = await manager.exec("require('dep');", {
  filename: '/home/user/run.js',
  cwd: '/home/user',
  captureOutput: true,
});
assert.equal(result.exitCode, 0, 'the exec under measurement succeeded');

const records = readExecTelemetry();
assert.equal(records.length, 1, 'one exec produced one record');
const [rec] = records;

assert.ok(rec.bundleBytes > 0, 'the bundle part of the map is measured');
assert.ok(
  rec.bundleBytes <= rec.moduleMapBytes,
  `the bundle (${rec.bundleBytes}) must fit inside the total it is part of (${rec.moduleMapBytes})`,
);
// The remainder is the runner and shims, which are fixed-size: no pass ships
// a table of the tree's names or stats alongside the bundle.
assert.ok(
  rec.moduleMapBytes - rec.bundleBytes < 2 * 1024 * 1024,
  `the unattributed remainder (${rec.moduleMapBytes - rec.bundleBytes}) is the fixed runner + shim, not a second pass`,
);
assert.equal(rec.namespaceRefusals, 0, 'a healthy launch refuses no synchronous call');

console.log('exec-telemetry-map-composition: ok');
