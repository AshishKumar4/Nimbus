#!/usr/bin/env bun
// A process has no wall deadline: it runs until it exits or is killed (kill,
// Ctrl-C), and the platform's CPU limit ends a runaway one. Only a direct
// compute call (a transform, a build, a fan-out task) carries a deadline.
//
// Measured live (SecureCricket, 2026-10-07): wasm-runner submitted every
// wasm program, WASI included, with a 30 s deadline, so clang over 10,000
// files under load was killed at 30 s ("Task exceeded 30000ms deadline",
// 9,199 of 10,000 files). A process waiting on stdin, or a long build, would
// die the same way at any fixed deadline.
//
// Time is what this test moves, not waits for: every timer of 10 s or more
// fires at once, as if that much time had passed. A deadline on the program
// below therefore ends it, and with none it completes.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const LONG_MS = 10_000;

const db = new Database(':memory:');
const harness = createSqliteVfsTestHarness(db);
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  generation: 1,
  cwd: '/home/user',
  facets: localFacetHost(ISOLATE_NETWORK),
});

// (module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))
const addWasm = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
ws.vfs.as(USER).writeFile('home/user/add.wasm', addWasm, { mode: 0o755 });

const realSetTimeout = globalThis.setTimeout;
const moved = [];
globalThis.setTimeout = (fn, ms, ...args) => {
  if (typeof ms === 'number' && ms >= LONG_MS) {
    moved.push(ms);
    return realSetTimeout(fn, 0, ...args);
  }
  return realSetTimeout(fn, ms, ...args);
};
let run;
try {
  run = await ws.exec('./add.wasm add 3 4');
} finally {
  globalThis.setTimeout = realSetTimeout;
}
assert.equal(run.exitCode, 0, `a wasm program outliving the old deadline was ended: ${run.stderr} (long timers: ${moved.join(', ')})`);
assert.equal(run.stdout, '7\n');
assert.deepEqual(moved, [], 'the program ran under no wall deadline');

console.log('process-no-wall-deadline: ok');
