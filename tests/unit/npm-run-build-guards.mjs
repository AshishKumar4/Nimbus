#!/usr/bin/env bun
// npm-run-build-guards — `npm run build` must fail loudly, never silently.
//
// G5: on a project with no `build` script, `npm run build` hung with zero
// output while `npm run dev` on the same project printed
// `npm ERR! Missing script`. The missing-script and missing-node_modules
// guards must run BEFORE any build dispatch, with output — and the
// `[npm:debug]` scaffolding must stay off the user-visible stream.
//
// Covers:
//   1. core `npmRun` (substrate): missing `build` script → exit 1 +
//      `Missing script: "build"` on stderr, no `[npm:debug]` anywhere.
//   2. core `npmRun` with a runnable script: dispatches past the
//      local-bin registration with no debug chatter.
//   3. `detectBundlerBin` classifies build-shaped scripts (next/vite).
//   4. `checkNodeModulesGuard` missing/present/zero-dep cases.
//   5. `withLoudTimeout` passes fast work through and rejects a stall
//      with an error naming what hung.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import {
  detectBundlerBin,
  checkNodeModulesGuard,
  withLoudTimeout,
} from '../../packages/worker/src/session/helpers.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// ── 1 + 2. core npmRun over a real workspace ─────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  let built = 0;
  ws.registry.register('mybuilder', () => { built++; return 0; });

  // No `build` script: the guard answers, exit 1, no debug scaffolding.
  await ws.fs.writeFile('/home/user/package.json', JSON.stringify({
    name: 'hx', version: '1.0.0', scripts: { format: 'prettier .' },
  }));
  const missing = await ws.exec('npm run build');
  assert.equal(missing.exitCode, 1, `missing build script exits 1 (got ${missing.exitCode})`);
  assert.match(missing.stderr, /Missing script: "build"/, `the guard names the script:\n${missing.stderr}`);
  assert.ok(!missing.stderr.includes('[npm:debug]'), `no debug scaffolding on stderr:\n${missing.stderr}`);
  assert.ok(!missing.stdout.includes('[npm:debug]'), `no debug scaffolding on stdout:\n${missing.stdout}`);

  // A runnable script dispatches past bin registration — still silent.
  await ws.fs.writeFile('/home/user/package.json', JSON.stringify({
    name: 'hx', version: '1.0.0', scripts: { build: 'mybuilder --flag' },
  }));
  const ran = await ws.exec('npm run build');
  assert.equal(ran.exitCode, 0, `runnable build script exits 0 (stderr=${ran.stderr})`);
  assert.equal(built, 1, 'the script body dispatched to the registered bin');
  assert.ok(!ran.stderr.includes('[npm:debug]'), `bin registration stays silent:\n${ran.stderr}`);
  console.log('  core npmRun: missing build guarded, runnable build silent-dispatches');
  harness.db.close();
}

// ── 3. detectBundlerBin on build-shaped scripts ──────────────────────────
{
  assert.equal(detectBundlerBin('next build'), 'next');
  assert.equal(detectBundlerBin('vite build'), 'vite');
  assert.equal(detectBundlerBin('npx vite build'), 'vite');
  assert.equal(detectBundlerBin('cross-env NODE_ENV=production next build'), 'next');
  assert.equal(detectBundlerBin('echo hi'), null);
  assert.equal(detectBundlerBin(''), null);
  console.log('  detectBundlerBin: next/vite build detected, plain scripts ignored');
}

// ── 4. checkNodeModulesGuard ─────────────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  const PROJ = 'nx';

  assert.deepEqual(checkNodeModulesGuard(root, PROJ), { missing: false, depCount: 0 });

  root.mkdir(PROJ, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({
    name: 'nx', scripts: { build: 'next build' },
    dependencies: { next: 'latest', react: 'latest' },
  }));
  assert.deepEqual(checkNodeModulesGuard(root, PROJ), { missing: true, depCount: 2 });

  root.mkdir(`${PROJ}/node_modules`, { recursive: true });
  assert.deepEqual(checkNodeModulesGuard(root, PROJ), { missing: false, depCount: 0 });

  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'nx', scripts: { build: 'echo hi' } }));
  const vfs2harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs2 = new SqliteVFS(vfs2harness.sql, vfs2harness.ctx);
  const root2 = vfs2.as(CRED_KERNEL);
  root2.mkdir('plain', { recursive: true });
  root2.writeFile('plain/package.json', JSON.stringify({ name: 'plain', scripts: { build: 'echo hi' } }));
  assert.deepEqual(checkNodeModulesGuard(root2, 'plain'), { missing: false, depCount: 0 });
  console.log('  checkNodeModulesGuard: missing/present/zero-dep cases');
  harness.db.close();
  vfs2harness.db.close();
}

// ── 5. withLoudTimeout ───────────────────────────────────────────────────
{
  assert.equal(await withLoudTimeout(Promise.resolve('fast'), 1_000, 'test work'), 'fast');

  await assert.rejects(
    withLoudTimeout(new Promise(() => {}), 50, 'vite build of /app/src/main.tsx'),
    (e) => {
      assert.match(e.message, /vite build of \/app\/src\/main\.tsx/);
      assert.match(e.message, /produced no result after/);
      return true;
    },
    'a stall rejects with an error naming the work',
  );

  // A genuine failure still surfaces as itself, not as a timeout.
  const boom = new Error('esbuild crashed');
  await assert.rejects(withLoudTimeout(Promise.reject(boom), 1_000, 'test work'), (e) => e === boom);
  console.log('  withLoudTimeout: passthrough, loud stall, failure preserved');
}

console.log('npm-run-build-guards: all assertions passed');
