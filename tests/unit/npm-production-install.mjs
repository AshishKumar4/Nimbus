#!/usr/bin/env bun
// npm-production-install — `npm install --production` (and `--omit=dev`,
// which resolves to the same flag) must not fetch devDependencies, and a
// refused package that only a devDependency declares must not fail it.
//
// When a refused package IS required, the install fails and the closing
// summary marks it `(devDependency)` and names the flag that installs the
// rest — the old per-package reject formatter's contract, now asserted on
// the public install output.
//
// Seam: the peer-DO RPC (`_rpcFanoutExecute`), mirroring
// tests/unit/npm-install-native-policy.mjs.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { npmRegistry } from './lib/npm-registry.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

function makeInstaller(pkgJson) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(PROJ, { recursive: true });
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
  const log = [];
  const { resultFor } = npmRegistry({
    ...Object.fromEntries(['ok-a', 'ok-b', 'ok-c', 'ok-d', 'ok-e', 'dev-x'].map((name) => [name, { '1.0.0': {} }])),
    puppeteer: { '24.0.0': {} },
  });
  const env = makeFanoutEnv({ root, NM, resultFor });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root };
}

// ── --omit=dev drops a listed dev root and its subtree ─────────────────
{
  const { installer, log, root } = makeInstaller({
    name: 'dev-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' },
    devDependencies: { puppeteer: '^24.0.0' },
  });
  const result = await installer.install(PROJ, { production: true });
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `omit=dev excludes the listed dev root (failed=${JSON.stringify(result.failed)})`);
  assert.ok(!/note: puppeteer|\[skip\].*puppeteer/.test(output), 'the listed subtree is never walked');
  assert.ok(/\bDone!/.test(output), 'the production install succeeds');
  assert.equal(result.installed.length, 5);
  assert.ok(root.exists(`${NM}/ok-a/package.json`), 'the declared deps are on disk');
  console.log('  --omit=dev: listed dev root excluded, exit 0');
}

// ── The same name under dependencies installs with an advisory ─────────
{
  const { installer, log, root } = makeInstaller({
    name: 'prod-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0', puppeteer: '^24.0.0' },
    devDependencies: { 'dev-x': '1.0.0' },
  });
  const result = await installer.install(PROJ, { production: true });
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a listed package installs even under --omit=dev (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: puppeteer has no Workers-compatible build: .*Chromium/.test(output), `the advisory names it:\n${output}`);
  assert.ok(root.exists(`${NM}/puppeteer/package.json`), 'puppeteer is on disk');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  --omit=dev: a listed required dep installs + note');
}

// ── A listed dev root under a normal install installs, marked dev ──────
{
  const { installer, log, root } = makeInstaller({
    name: 'dev-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' },
    devDependencies: { puppeteer: '^24.0.0' },
  });
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a dev-only listed package installs (failed=${JSON.stringify(result.failed)})`);
  assert.ok(
    /\[npm\] note: puppeteer has no Workers-compatible build \(declared in devDependencies\): /.test(output),
    `the advisory marks it (devDependency):\n${output}`,
  );
  assert.ok(root.exists(`${NM}/puppeteer/package.json`), 'puppeteer is on disk');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  dev-only listed package installs with a (devDependencies) advisory');
}

console.log('npm-production-install: all assertions passed');
