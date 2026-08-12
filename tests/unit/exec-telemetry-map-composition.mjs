#!/usr/bin/env bun
/**
 * The exec record has to say what the module map is MADE OF, not only how big
 * it is.
 *
 * A total on its own points at nothing. `pi --version` was diagnosed as a
 * snapshot REBUILD on the strength of `bundleMs` — which workerd's frozen
 * clock reports as 0 once the VFS reads are warm — while the seconds actually
 * sat in `runMs`, a fresh isolate taking a 23 MB map. Splitting the total into
 * the three passes that produce it is what makes the next such question
 * answerable from the record instead of from a guess.
 *
 * The split is checked against the total it decomposes, so it cannot drift
 * into measuring something else and still look plausible.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { readExecTelemetry, resetExecTelemetry } from '../../packages/worker/src/facets/exec-telemetry.ts';

process.env.NIMBUS_DIAG_EXEC = '1';

setCtxExports({
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
  { id: { toString: () => 'exec-telemetry-composition' }, waitUntil() {} },
  env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {},
);
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(vfs);

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
assert.ok(rec.manifestBytes > 0, 'the manifest part of the map is measured');
assert.ok(rec.metadataBytes > 0, 'the metadata part of the map is measured');

// The three are parts OF the total, so their sum cannot exceed it — that is
// what stops the split from silently coming to mean something else.
const parts = rec.bundleBytes + rec.manifestBytes + rec.metadataBytes;
assert.ok(
  parts <= rec.moduleMapBytes,
  `the parts (${parts}) must fit inside the total they decompose (${rec.moduleMapBytes})`,
);
// …and they have to be most of it, or the record still points at nothing: the
// remainder is the shim plus the runner boilerplate, which is fixed-size.
assert.ok(
  rec.moduleMapBytes - parts < 2 * 1024 * 1024,
  `the unattributed remainder (${rec.moduleMapBytes - parts}) is the fixed runner + shim, not a fourth pass`,
);

// The metadata describes every path the manifest named, so a tree whose files
// nothing requires still costs metadata. That is the cost the split exists to
// make visible.
assert.ok(
  rec.metadataBytes > 40 * 'home/user/node_modules/dep/lib/unusedNN.js'.length,
  'metadata prices the files nothing required, which is what the split reveals',
);

console.log('exec-telemetry-map-composition: ok');
