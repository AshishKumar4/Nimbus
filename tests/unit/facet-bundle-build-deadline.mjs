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
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import {
  BUNDLE_BUILD_DEADLINE_MS,
} from '../../packages/core/src/constants.ts';
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

console.log(`  reported at ${elapsed}ms against a ${BUNDLE_BUILD_DEADLINE_MS}ms bound`);

// ── The deadline scales with the installed tree, bounded ────────────────────
//
// Measured on the session DO (2026-09-14): a 752-package tree built its
// bundle in 14.6 s cold — ~20 ms per package in the reads, transforms and
// manifest walk that scale with the tree. A 20 s bound on a defect must not
// report a large tree as one; past 60 s it is a defect whatever the tree.
{
  const { bundleBuildDeadlineMs, BUNDLE_BUILD_DEADLINE_PER_PACKAGE_MS, BUNDLE_BUILD_DEADLINE_MAX_MS } =
    await import('../../packages/core/src/constants.ts');
  const { countInstalledPackages } = await import('../../packages/worker/src/facets/manager.ts');
  assert.equal(bundleBuildDeadlineMs(0), BUNDLE_BUILD_DEADLINE_MS, 'an empty tree keeps the floor');
  assert.equal(bundleBuildDeadlineMs(752), BUNDLE_BUILD_DEADLINE_MS + 752 * BUNDLE_BUILD_DEADLINE_PER_PACKAGE_MS, 'the measured tree gets its measured budget');
  assert.equal(bundleBuildDeadlineMs(3000), BUNDLE_BUILD_DEADLINE_MAX_MS, 'a huge tree is capped');
  assert.equal(bundleBuildDeadlineMs(-5), BUNDLE_BUILD_DEADLINE_MS);

  // The count is one readdir per scope, not a walk.
  const { CRED_KERNEL } = await import('../../packages/core/src/runtime/os-contracts.ts');
  const root = vfs.as(CRED_KERNEL);
  for (const p of ['home/user/proj/node_modules/a', 'home/user/proj/node_modules/b', 'home/user/proj/node_modules/@s/x', 'home/user/proj/node_modules/@s/y', 'home/user/proj/node_modules/.bin']) {
    root.mkdir(p, { recursive: true });
  }
  root.writeFile('home/user/proj/node_modules/.package-lock.json', '{}');
  assert.equal(countInstalledPackages(root, '/home/user/proj'), 4, 'two plain + two scoped, dotted entries ignored');
  assert.equal(countInstalledPackages(root, '/home/user/nowhere'), 0);
  console.log('  deadline scales 20 ms/package from 20 s, capped at 60 s');
}

console.log('facet-bundle-build-deadline: ok');
