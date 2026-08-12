#!/usr/bin/env bun
// A cache miss must never be a silent hang.
//
// The prefetch bundle build was awaited entirely OUTSIDE `_execWithTimeout`,
// which wraps only `_execViaLoader`. So every timeout in the system — the 30 s
// facet bound, the 60 s bin-dispatch bound — sat downstream of a step that
// could take arbitrarily long, and a heavy build wedged the session Durable
// Object with nothing able to report it: a terminal that goes quiet and never
// returns, with no exit record for the process.
//
// The bound is on the BUILD, so this test stalls the build and nothing else.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { BUNDLE_BUILD_DEADLINE_MS } from '../../packages/worker/src/constants.ts';
import { createFacetWorld, createFacetCtx } from './facet-host-harness.mjs';

const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);

const world = createFacetWorld(async () => ({
  async startProcess() { return {}; },
  async handleHttpRequest() { return new Response('{}'); },
}));
const ctx = createFacetCtx(world, 'bundle-deadline-session');
const manager = new FacetManager(ctx, { LOADER: world.loader }, new SessionProcessSupervisor(), new PortRegistry(), processHostFor, {});
manager.setVfs(vfs);

// ── A build that never settles must be REPORTED, not waited on forever ─────
//
// Replacing the builder is the honest seam: the defect was never about what
// the builder does, only that whatever it did was unbounded.
let released;
const stalled = new Promise((resolve) => { released = resolve; });
manager._buildPrefetchBundleCached = () => stalled;

const t0 = Date.now();
await assert.rejects(
  () => manager.exec('console.log(1)', { filename: '/home/user/x.js', cwd: '/home/user' }),
  (e) => {
    assert.match(
      String(e?.message),
      /assembling the filesystem bundle/,
      `the failure must name the bundle build, got: ${e?.message}`,
    );
    assert.match(
      String(e?.message),
      /was not started/,
      'the failure must say the process never started, so it is not read as a program crash',
    );
    return true;
  },
  'an unbounded bundle build must fail loudly rather than hang',
);
const elapsed = Date.now() - t0;

// It must fire at its own deadline, not at some outer bound that happens to
// exist — the whole defect was that no outer bound applied here.
assert.ok(
  elapsed >= BUNDLE_BUILD_DEADLINE_MS * 0.5,
  `must actually wait for the deadline, returned in ${elapsed}ms`,
);
assert.ok(
  elapsed < BUNDLE_BUILD_DEADLINE_MS * 2,
  `must not overshoot the deadline, took ${elapsed}ms`,
);

// The abandoned build must not surface later as an unhandled rejection.
released({ bundle: {}, manifest: {}, metadata: {}, reachableCount: 0, truncated: false });
await new Promise((r) => setTimeout(r, 50));

console.log('facet-bundle-build-deadline: ok');
console.log(`  reported at ${elapsed}ms against a ${BUNDLE_BUILD_DEADLINE_MS}ms bound`);
