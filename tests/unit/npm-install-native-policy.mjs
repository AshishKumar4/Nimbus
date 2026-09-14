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

// ── Case E: a refused dep UNDER a root devDependency is non-fatal ──────
//
// vite@8 (rolldown-based) declares lightningcss as a required
// `dependencies` edge; `npm create vite` lists vite in devDependencies,
// so the refusal used to exit 1. Required is now end-of-walk: lightningcss
// is only reachable through dev-only vite, so it skips and vite installs.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  // vite's children pad the second layer to the peer-DO width the harness
  // fakes; the refused name is what this case asserts.
  const viteDeps = { lightningcss: '^1.30.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0', 'vc-3': '1.0.0', 'vc-4': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'vite-app', dependencies: ok, devDependencies: { vite: '^8.0.0' } },
    (name) => {
      if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
      if (name === 'lightningcss') {
        return rejectedResult(
          'lightningcss',
          'Native Rust CSS parser; ships platform-specific .node bindings plus a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi, and the package probes libc through child_process.execSync.',
          'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
        );
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a refusal under a devDependency does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*lightningcss — /.test(output), `the skip line is still logged:\n${output}`);
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), `no closing summary without required refusals:\n${output}`);
  assert.ok(result.installed.some((entry) => entry.startsWith('vite@')), `vite itself installs (installed=${JSON.stringify(result.installed)})`);
  assert.ok(root.exists(`${NM}/vite/package.json`), 'vite is on disk');
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseE: lightningcss under dev-only vite skips, vite installs, exit 0');
}

// ── Case F: a refused dep UNDER a root dependency fails, summary names it ─
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const appDeps = { lightningcss: '^1.30.0', 'sc-1': '1.0.0', 'sc-2': '1.0.0', 'sc-3': '1.0.0', 'sc-4': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'needs-lightningcss', dependencies: { ...ok, 'some-app-dep': '^1.0.0' } },
    (name) => {
      if (name === 'some-app-dep') return resolvedResult(name, '1.0.0', { dependencies: appDeps });
      if (name === 'lightningcss') {
        return rejectedResult(
          'lightningcss',
          'Native Rust CSS parser; ships platform-specific .node bindings plus a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi, and the package probes libc through child_process.execSync.',
          'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
        );
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('lightningcss'), `a required refusal lands in failed (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*lightningcss — .*… try:/.test(output), `the skip line carries the hint:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: lightningcss/.test(output),
    `the closing summary names it:\n${output}`,
  );
  assert.ok(root.exists(`${NM}/some-app-dep/package.json`), 'the required parent still installs');
  assert.ok(!/\bDone!/.test(output), 'no success line on a partial install');
  console.log('  caseF: lightningcss under a root dependency fails, summary names it');
}

// ── Case G: dev-first, required-later — end-of-walk required wins ──────
//
// lightningcss is reached in an early layer under dev-only vite AND, two
// layers later, under root-dependency chain a → b. Classification happens
// after the walk, so the later required edge upgrades the refusal even
// though the name was already seen under the dev parent.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const viteDeps = { lightningcss: '^1.30.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0', 'vc-3': '1.0.0', 'vc-4': '1.0.0' };
  const aDeps = { b: '1.0.0', 'ac-1': '1.0.0', 'ac-2': '1.0.0', 'ac-3': '1.0.0', 'ac-4': '1.0.0' };
  // b's layer keeps the peer-DO width after lightningcss is filtered as
  // already-seen.
  const bDeps = { lightningcss: '^1.30.0', 'bc-1': '1.0.0', 'bc-2': '1.0.0', 'bc-3': '1.0.0', 'bc-4': '1.0.0', 'bc-5': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'mixed-app', dependencies: { ...ok, a: '^1.0.0' }, devDependencies: { vite: '^8.0.0' } },
    (name) => {
      if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
      if (name === 'a') return resolvedResult(name, '1.0.0', { dependencies: aDeps });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: bDeps });
      if (name === 'lightningcss') {
        return rejectedResult(
          'lightningcss',
          'Native Rust CSS parser; ships platform-specific .node bindings plus a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi, and the package probes libc through child_process.execSync.',
          'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
        );
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('lightningcss'), `the later required edge upgrades the refusal (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*lightningcss — /.test(output), `the skip line is logged once at refusal time:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: lightningcss/.test(output),
    `the closing summary names it:\n${output}`,
  );
  console.log('  caseG: dev-first sighting, later required edge — end-of-walk required wins');
}

// ── Case H: a refused dep under an optionalDependencies subtree ────────
//
// optionalDependencies are never required edges, so a `dependencies`
// edge out of an optional package does not propagate requiredness.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const optDeps = { y: '^1.0.0', 'xo-1': '1.0.0', 'xo-2': '1.0.0', 'xo-3': '1.0.0', 'xo-4': '1.0.0' };
  const yDeps = { sharp: '^0.34.0', 'yc-1': '1.0.0', 'yc-2': '1.0.0', 'yc-3': '1.0.0', 'yc-4': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'opt-subtree', dependencies: { ...ok, x: '^1.0.0' } },
    (name) => {
      if (name === 'x') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optDeps });
        r.optionalDeps = optDeps;
        return r;
      }
      if (name === 'y') return resolvedResult(name, '1.0.0', { dependencies: yDeps });
      if (name === 'sharp') {
        return rejectedResult('sharp', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a refusal under an optional subtree does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the skip line is logged:\n${output}`);
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), `no closing summary without required refusals:\n${output}`);
  assert.ok(root.exists(`${NM}/y/package.json`), 'the optional package itself installs');
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseH: sharp under an optionalDependencies subtree skips, exit 0');
}

console.log('npm-install-native-policy: all assertions passed');
