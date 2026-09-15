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
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

function resolvedResult(name, version, overrides = {}) {
  return {
    pkg: {
      name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
      dependencies: {}, exports: null, main: 'index.js', module: '', bin: {}, ...overrides,
    },
    deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
  };
}

function makeInstaller(pkgJson) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(PROJ, { recursive: true });
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
  const log = [];
  const env = {
    LOADER: { get() { return {}; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      get() {
        return {
          async _rpcFanoutExecute(_fnSource, args) {
            if (args[0] && Array.isArray(args[0].packages)) {
              return { results: args.map((shard) => ({
                perPackage: shard.packages.map((p) => {
                  root.mkdir(`${NM}/${p.name}`, { recursive: true });
                  root.writeFile(`${NM}/${p.name}/package.json`, JSON.stringify({ name: p.name, version: p.version }));
                  return { name: p.name, version: p.version, fileCount: 1, bytesWritten: 40, elapsed: 1, warnings: [] };
                }),
                elapsed: 1,
                facetCounters: { tarballsCompleted: 0, cumulativeBytesDecoded: 0, peakInFlight: 1, pipelinedTarballRaceWins: 0, pipelinedTarballRaceLosses: 0 },
                cacheStatEvents: [],
              })) };
            }
            return { results: args.map((spec) => resolvedResult(spec.name, '1.0.0')) };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root };
}

// ── --omit=dev drops a refused dev root and its subtree ────────────────
{
  const { installer, log, root } = makeInstaller({
    name: 'dev-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' },
    devDependencies: { puppeteer: '^24.0.0' },
  });
  const result = await installer.install(PROJ, { production: true });
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `omit=dev excludes the refused dev root (failed=${JSON.stringify(result.failed)})`);
  assert.ok(!/\[skip\].*puppeteer/.test(output), 'the refused subtree is never walked');
  assert.ok(/\bDone!/.test(output), 'the production install succeeds');
  assert.equal(result.installed.length, 5);
  assert.ok(root.exists(`${NM}/ok-a/package.json`), 'the declared deps are on disk');
  console.log('  --omit=dev: refused dev root excluded, exit 0');
}

// ── The same name under dependencies is required and fails ─────────────
{
  const { installer, log } = makeInstaller({
    name: 'prod-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0', puppeteer: '^24.0.0' },
    devDependencies: { 'dev-x': '1.0.0' },
  });
  const result = await installer.install(PROJ, { production: true });
  const output = log.join('\n');

  assert.ok(result.failed.includes('puppeteer'), `a required refusal fails even under --omit=dev (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/required package is not supported on Nimbus.*puppeteer/.test(output), `the summary names it:\n${output}`);
  console.log('  --omit=dev: a required refusal still fails');
}

// ── A refused dev root under a normal install fails with guidance ──────
{
  const { installer, log } = makeInstaller({
    name: 'dev-tool',
    dependencies: { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' },
    devDependencies: { puppeteer: '^24.0.0' },
  });
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('puppeteer'), `a dev-only refusal fails honestly (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*puppeteer — /.test(output), `the per-package skip line is logged:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: puppeteer \(devDependency\)/.test(output),
    `the summary marks it (devDependency):\n${output}`,
  );
  assert.ok(
    /--omit=dev/.test(output),
    `and names the flag that installs the rest:\n${output}`,
  );
  console.log('  dev-only refusal fails with (devDependency) + --omit=dev guidance');
}

console.log('npm-production-install: all assertions passed');
