#!/usr/bin/env bun
// The hosted runtime owns /.nimbus/facet-images whole, so it removes the
// generated program images earlier releases left there with environments in
// them (ask 62); a session's manager under any other host only lists them.
// Through composeHostedRuntime over a session an earlier release used:
//   - its first turn removes the generated entry in /.nimbus/facet-images;
//   - one below /var/lib/nimbus (the user's /var) stays, listed;
//   - an image of the directory that is not a generated entry stays.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/worker/src/facets/legacy-images.ts': ['legacyGeneratedImages'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});
const { CRED_KERNEL } = bundle;
bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);

/** A file at its content address in `dir`, as the kernel wrote it. */
async function imageAt(dir, text) {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('');
  kernel.mkdir(dir, { recursive: true, mode: 0o755 });
  kernel.writeFile(`${dir}/${digest}.js`, text, { mode: 0o644 });
  return `${dir}/${digest}.js`;
}
// A generated entry as the store composed it (a recipe), its arguments holding the env.
const entry = JSON.stringify(['import { DurableObject } from "cloudflare:workers";\nconst __NIMBUS_ARGS = {"argv":[],"env":{"SECRET":"hosted-legacy-9c1f"}};\n', { path: '/node-shims/shims.js', sha256: '0'.repeat(64) }, '\nexport class NimbusProcess extends DurableObject {}\n']);
const ours = await imageAt('.nimbus/facet-images', entry);
const users = await imageAt('var/lib/nimbus/facet-images', entry);
const other = await imageAt('.nimbus/facet-images', 'export const answer = 42;\n');
assert.deepEqual(bundle.legacyGeneratedImages(vfs).sort(), [ours, users].sort(), 'both generated entries are listed');

const facetCtx = createFacetCtx(world, 'hosted-legacy-images', new Map());
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const processes = new bundle.SessionProcessSupervisor();
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };
const runtime = await bundle.composeHostedRuntime({ workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime) });
try {
  // Its first turn: a command, as a session's first does.
  const ran = await runtime.exec('true', {});
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(kernel.exists(ours), false, 'the hosted runtime removed the generated entry it owns');
  assert.equal(kernel.exists(users), true, 'the one below the user\'s /var stays');
  assert.equal(kernel.exists(other), true, 'and an image that is not a generated entry stays');
  assert.deepEqual(bundle.legacyGeneratedImages(vfs), [users], 'which is what is listed now');
} finally {
  await runtime.close();
  await workspace.close();
}
console.log('hosted-legacy-images: the hosted runtime removes the generated entries it owns, and lists the rest');
