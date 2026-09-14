#!/usr/bin/env bun
// npm-install-native-policy — one unsupported native package must not
// reject the whole install (G2).
//
// `npm install` on a create-next-app project wrote NOTHING because `sharp`
// sat in next's tree, and `npm install esbuild sharp` announced the
// esbuild→esbuild-wasm swap but installed nothing: any registry refusal
// threw RegistryRejectError and aborted the batch.
//
// Required behavior under test:
//   - swaps always apply, even when a sibling spec is refused;
//   - every refused package gets the per-package
//     `[skip] <pkg> — <reason> … try: <hint>` line;
//   - the rest of the tree installs either way;
//   - exit-code contract (via the `failed` list the shell maps to the
//     exit code): 0 when every refusal arrived only through optional
//     edges (optionalDependencies, optional peers, root devDependencies),
//     1 with the closing "N required packages are not supported on
//     Nimbus: …" summary otherwise.
//
// Seam: the peer-DO RPC (`_rpcFanoutExecute`), mirroring
// tests/unit/npm-install-partial-honesty.mjs. Registry refusals use the
// real policy table (`sharp`).

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

function rejectedResult(from, reason, suggest) {
  return {
    pkg: null, deps: {}, peerDeps: {}, optionalDeps: {}, allPeerDependencies: {},
    cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [],
    error: { type: 'w6-reject', from, reason, suggest },
  };
}

function makeInstaller(pkgJson, resultFor) {
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
            return { results: args.map((spec) => resultFor(spec.name)) };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root, harness };
}

// ── Case A: a REQUIRED refused dep fails the install but installs the rest ─
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'needs-sharp', dependencies: { ...ok, sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('sharp'), `required refusal lands in failed (failed=${JSON.stringify(result.failed)})`);
  assert.equal(result.installed.length, 5, 'the supportable remainder still installs');
  assert.ok(root.exists(`${NM}/ok-a/package.json`), 'the remainder is on disk');
  assert.ok(/\[skip\].*sharp — .*… try:/.test(output), `the per-package skip line carries the hint:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: sharp/.test(output),
    `the closing summary names it:\n${output}`,
  );
  assert.ok(!/\bDone!/.test(output), 'no success line on a partial install');
  // Exit-code contract: the shell maps a non-empty `failed` to exit 1.
  assert.ok(result.failed.length > 0, 'exit-code contract: failed is non-empty');
  console.log('  caseA: required sharp fails the install, rest installs, summary names it');
}

// ── Case B: an OPTIONAL-only refusal is a skip, exit 0 ───────────────────
//
// Five optional edges so the second resolve layer stays on the peer-DO
// topology the harness fakes (width >= IN_DO_THRESHOLD), like every
// other layer in this file.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const optShards = { sharp: '^0.34.0', 'opt-1': '^1.0.0', 'opt-2': '^1.0.0', 'opt-3': '^1.0.0', 'opt-4': '^1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'opt-sharp', dependencies: ok },
    (name) => {
      if (name === 'ok-a') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optShards });
        r.optionalDeps = optShards;
        return r;
      }
      if (name === 'sharp') {
        return rejectedResult('sharp', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `an optional-only refusal does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — .*… try:.*Cloudflare Images/.test(output), `the skip line carries the hint:\n${output}`);
  assert.ok(/\bDone!/.test(output), 'an install with only optional skips still succeeds');
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no closing summary without required refusals');
  console.log('  caseB: optional-only sharp skips, install succeeds');
}

// ── Case C: swap applies even when the sibling spec is refused ───────────
{
  const { installer, log, root } = makeInstaller(
    { name: 'x', dependencies: {} },
    (name) => {
      if (name === 'esbuild-wasm') return resolvedResult('esbuild', '0.27.0');
      return resolvedResult(name, '1.0.0');
    },
  );
  // Padding specs keep the resolve layer on the peer-DO topology the
  // harness fakes (width >= IN_DO_THRESHOLD); the swap and the refusal
  // are what this case asserts.
  const result = await installer.install(PROJ, { packages: ['esbuild', 'sharp', 'pad-a', 'pad-b', 'pad-c', 'pad-d'] });
  const output = log.join('\n');

  assert.ok(/\[swap\].*esbuild → esbuild-wasm/.test(output), `the swap is announced:\n${output}`);
  assert.ok(
    result.installed.some((entry) => entry.startsWith('esbuild@')),
    `the swap target installs under the requested name (installed=${JSON.stringify(result.installed)})`,
  );
  assert.ok(root.exists(`${NM}/esbuild/package.json`), 'esbuild is on disk under its own name');
  assert.ok(result.failed.includes('sharp'), `the refused sibling lands in failed (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the sibling gets its skip line:\n${output}`);
  const pkgJson = JSON.parse(root.readFileString(`${PROJ}/package.json`));
  assert.ok(pkgJson.dependencies?.esbuild, 'package.json records the swapped spec');
  assert.ok(!pkgJson.dependencies?.sharp, 'package.json does not record the refused spec');
  console.log('  caseC: esbuild→esbuild-wasm installs while sharp fails');
}

// ── Case D: a devDependency-only refusal is dev-optional, exit 0 ─────────
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'dev-sharp', dependencies: ok, devDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a dev-only refusal does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the skip line is still logged:\n${output}`);
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseD: dev-only sharp skips, install succeeds');
}

console.log('npm-install-native-policy: all assertions passed');
