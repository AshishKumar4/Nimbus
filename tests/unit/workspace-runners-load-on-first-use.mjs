#!/usr/bin/env bun
// A workspace with a facet host loads each runtime runner's module when the
// first command needs it, not at create. Importing all of them at boot cost
// every workspace isolate 0.65 MB whether or not a runner ever ran
// (measured by Kinu, 2026-09-30, in a Durable Object with 128 MB).

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';

const RUNNER_MODULES = /\/runtime\/(bash-runner|cpython-runner|ruby-runner|clang-runner|wasm-runner|runtime-registry)\.ts$/;
const loaded = () => Object.keys(require.cache)
  .filter((key) => RUNNER_MODULES.test(key))
  .map((key) => key.slice(key.lastIndexOf('/') + 1))
  .sort();

assert.deepEqual(loaded(), [], 'no runner module is loaded before the workspace');
const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, facets: localFacetHost() });
assert.deepEqual(loaded(), [], 'create loads no runner module');

const version = await ws.exec('wasm-runner --version');
assert.equal(version.exitCode, 0, `wasm-runner runs on first use: ${version.stderr}`);
assert.deepEqual(loaded(), ['runtime-registry.ts', 'wasm-runner.ts'], 'and loads only its own modules');
assert.equal((await ws.exec('wasm-runner --version')).stdout, version.stdout, 'a second run reuses them');

console.log('workspace-runners-load-on-first-use: runners load with the first command that needs them');
