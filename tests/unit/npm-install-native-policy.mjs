#!/usr/bin/env bun
// npm-install-native-policy — one unsupported native package must not
// reject the whole install (G2), but a REQUIRED refusal must fail it.
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
//     exit code): 0 when every refusal is reachable only through
//     optional roots/edges (optionalDependencies, best-effort optional
//     peers), 1 with the closing "N required packages are not supported
//     on Nimbus: …" summary otherwise. Dependencies AND devDependencies
//     are required roots — a dev-only refusal fails with the
//     `(devDependency)` / `--omit=dev` guidance, it does not exit 0.
//   - requiredness is computed over the resolved graph at end of walk:
//     a name first sighted under an optional/dev ancestor is still
//     required when a required chain reaches it later, in ANY layer.
//
// Seam: the peer-DO RPC (`_rpcFanoutExecute`), mirroring
// tests/unit/npm-install-partial-honesty.mjs. Registry refusals use the
// real policy table names (`sharp`, `lightningcss`).

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

const LIGHTNINGCSS = {
  reason:
    'Native Rust CSS parser; ships platform-specific .node bindings plus a wasm32-wasi-only `lightningcss-wasm` package. workerd has no node:wasi, and the package probes libc through child_process.execSync.',
  suggest:
    'no Workers-compatible target today — postcss + cssnano (pure JS, untested by Nimbus) cover most lightningcss use cases. For CSS minification only: clean-css (pure JS, untested by Nimbus).',
};

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

// ── Case D: a devDependency refusal is required — exit 1 with guidance ───
//
// devDependencies are REQUIRED unless omitted: a refused dev tool fails
// the install honestly (the package is absent; claiming Done! was the
// pre-train bug), and the summary says it is a devDependency and names
// the flag that installs the rest. The supported siblings still install.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'dev-sharp', dependencies: ok, devDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('sharp'), `a dev-only refusal still fails (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the skip line is still logged:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: sharp \(devDependency\)/.test(output),
    `the summary marks it devDependency:\n${output}`,
  );
  assert.ok(/--omit=dev/.test(output), `and names the flag that installs the rest:\n${output}`);
  assert.equal(result.installed.length, 5, 'the supported siblings still install');
  assert.ok(root.exists(`${NM}/ok-a/package.json`), 'the siblings are on disk');
  assert.ok(!/\bDone!/.test(output), 'no success line on a refused install');
  console.log('  caseD: dev-only sharp fails honestly with (devDependency) + --omit=dev guidance');
}

// ── Case E: vite@8 as a devDependency — lightningcss is REQUIRED ────────
//
// vite@8 (rolldown-based) declares lightningcss as a required
// `dependencies` edge; `npm create vite` lists vite in devDependencies.
// Because devDependencies are required roots, the refusal fails the
// install — the honest outcome until vite8/native support lands.
// `--omit=dev` is the documented way past it and must exit 0.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const viteDeps = { lightningcss: '^1.30.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0', 'vc-3': '1.0.0', 'vc-4': '1.0.0' };
  const resultFor = (name) => {
    if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
    if (name === 'lightningcss') return rejectedResult('lightningcss', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
    return resolvedResult(name, '1.0.0');
  };
  const pkgJson = { name: 'vite-app', dependencies: ok, devDependencies: { vite: '^8.0.0' } };

  const first = makeInstaller(pkgJson, resultFor);
  const result = await first.installer.install(PROJ);
  const output = first.log.join('\n');
  assert.ok(result.failed.includes('lightningcss'), `lightningcss under a dev root is required (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*lightningcss — /.test(output), `the skip line is logged:\n${output}`);
  assert.ok(/required package is not supported on Nimbus.*lightningcss/.test(output), `the summary names it:\n${output}`);
  assert.ok(result.installed.some((entry) => entry.startsWith('vite@')), 'vite itself still installs');
  assert.ok(first.root.exists(`${NM}/vite/package.json`), 'vite is on disk');
  assert.ok(!/\bDone!/.test(output), 'no success line on a partial install');

  // --production / --omit=dev drops the dev root AND its whole subtree.
  const prod = makeInstaller(pkgJson, resultFor);
  const prodResult = await prod.installer.install(PROJ, { production: true });
  const prodOutput = prod.log.join('\n');
  assert.deepEqual(prodResult.failed, [], `--omit=dev installs the rest (failed=${JSON.stringify(prodResult.failed)})`);
  assert.ok(!/\[skip\].*lightningcss/.test(prodOutput), 'the refused subtree is never walked under --omit=dev');
  assert.ok(/\bDone!/.test(prodOutput), 'production install succeeds');
  console.log('  caseE: lightningcss under dev-only vite fails honestly; --omit=dev exits 0');
}

// ── Case F: a refused dep UNDER a root dependency fails, summary names it ─
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const appDeps = { lightningcss: '^1.30.0', 'sc-1': '1.0.0', 'sc-2': '1.0.0', 'sc-3': '1.0.0', 'sc-4': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'needs-lightningcss', dependencies: { ...ok, 'some-app-dep': '^1.0.0' } },
    (name) => {
      if (name === 'some-app-dep') return resolvedResult(name, '1.0.0', { dependencies: appDeps });
      if (name === 'lightningcss') return rejectedResult('lightningcss', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
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

// ── Case G: dev-first ancestor, required edge deeper — end-of-walk wins ─
//
// The discriminating case for graph-closure classification: `c` resolves
// at depth 1 under dev-only vite and ALSO at depth 3 under the required
// chain a→p1→b. The refusal sits under `c`, so only an end-of-walk
// closure over the resolved graph marks it required — incremental
// edge-time propagation misses it (c's edges were walked before the
// required sighting).
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const viteDeps = { c: '1.0.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0', 'vc-3': '1.0.0', 'vc-4': '1.0.0' };
  const aDeps = { p1: '1.0.0', 'ac-1': '1.0.0', 'ac-2': '1.0.0', 'ac-3': '1.0.0', 'ac-4': '1.0.0' };
  const p1Deps = { b: '1.0.0', 'pc-1': '1.0.0', 'pc-2': '1.0.0', 'pc-3': '1.0.0', 'pc-4': '1.0.0' };
  const bDeps = { c: '1.0.0', 'bc-1': '1.0.0', 'bc-2': '1.0.0', 'bc-3': '1.0.0', 'bc-4': '1.0.0', 'bc-5': '1.0.0' };
  const cDeps = { lightningcss: '^1.30.0', 'cc-1': '1.0.0', 'cc-2': '1.0.0', 'cc-3': '1.0.0', 'cc-4': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'mixed-app', dependencies: { ...ok, a: '^1.0.0' }, devDependencies: { vite: '^8.0.0' } },
    (name) => {
      if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
      if (name === 'a') return resolvedResult(name, '1.0.0', { dependencies: aDeps });
      if (name === 'p1') return resolvedResult(name, '1.0.0', { dependencies: p1Deps });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: bDeps });
      if (name === 'c') return resolvedResult(name, '1.0.0', { dependencies: cDeps });
      if (name === 'lightningcss') return rejectedResult('lightningcss', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('lightningcss'), `the later required chain upgrades the refusal (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*lightningcss — /.test(output), `the skip line is logged once at refusal time:\n${output}`);
  assert.ok(
    /1 required package is not supported on Nimbus: lightningcss/.test(output),
    `the closing summary names it:\n${output}`,
  );
  console.log('  caseG: dev-first ancestor, deeper required chain — end-of-walk closure wins');
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

// ── Case I: a refused optionalDependencies ROOT is non-fatal ───────────
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'opt-root', dependencies: ok, optionalDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a refused optional root does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the skip line is logged:\n${output}`);
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no closing summary for an optional root');
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseI: refused optionalDependencies root skips, exit 0');
}

// ── Case J: optionalDependencies overrides a dependencies entry ────────
//
// npm semantics: a name in BOTH maps is optional. sharp under
// dependencies AND optionalDependencies refuses non-fatally.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'both-maps', dependencies: { ...ok, sharp: '^0.34.0' }, optionalDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `the optional entry wins over the dependency (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*sharp — /.test(output), `the skip line is logged:\n${output}`);
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseJ: name in dependencies+optionalDependencies is optional, exit 0');
}

// ── Case K: optional-first ancestor, required chain deeper — fails ──────
//
// `c` resolves under optional root `optional-root` AND under the required
// chain a→p1→b. sharp sits under c: optional-first ordering must not
// shield a required reach.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const optDeps = { 'optional-root': '^1.0.0', 'xo-1': '1.0.0', 'xo-2': '1.0.0', 'xo-3': '1.0.0', 'xo-4': '1.0.0' };
  const aDeps = { p1: '1.0.0', 'ac-1': '1.0.0', 'ac-2': '1.0.0', 'ac-3': '1.0.0', 'ac-4': '1.0.0' };
  const p1Deps = { b: '1.0.0', 'pc-1': '1.0.0', 'pc-2': '1.0.0', 'pc-3': '1.0.0', 'pc-4': '1.0.0' };
  const bDeps = { c: '1.0.0', 'bc-1': '1.0.0', 'bc-2': '1.0.0', 'bc-3': '1.0.0', 'bc-4': '1.0.0', 'bc-5': '1.0.0' };
  const cDeps = { sharp: '^0.34.0', 'cc-1': '1.0.0', 'cc-2': '1.0.0', 'cc-3': '1.0.0', 'cc-4': '1.0.0' };
  const orDeps = { c: '1.0.0', 'oc-1': '1.0.0', 'oc-2': '1.0.0', 'oc-3': '1.0.0', 'oc-4': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'opt-first', dependencies: { ...ok, a: '^1.0.0', x: '^1.0.0' } },
    (name) => {
      if (name === 'x') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optDeps });
        r.optionalDeps = optDeps;
        return r;
      }
      if (name === 'optional-root') return resolvedResult(name, '1.0.0', { dependencies: orDeps });
      if (name === 'a') return resolvedResult(name, '1.0.0', { dependencies: aDeps });
      if (name === 'p1') return resolvedResult(name, '1.0.0', { dependencies: p1Deps });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: bDeps });
      if (name === 'c') return resolvedResult(name, '1.0.0', { dependencies: cDeps });
      if (name === 'sharp') return rejectedResult('sharp', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('sharp'), `the required chain to the shared ancestor wins (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/required package is not supported on Nimbus.*sharp/.test(output), `the summary names it:\n${output}`);
  console.log('  caseK: optional-first ancestor, deeper required chain — sharp is required');
}

// ── Case L: cycles in the required graph terminate ─────────────────────
{
  // b's edge back to a keeps the layer-2 width at the peer-DO threshold
  // after `a` is filtered as already-seen.
  const { installer } = makeInstaller(
    { name: 'cyclic', dependencies: { a: '^1.0.0', 'ok-1': '1.0.0', 'ok-2': '1.0.0', 'ok-3': '1.0.0', 'ok-4': '1.0.0' } },
    (name) => {
      if (name === 'a') return resolvedResult(name, '1.0.0', { dependencies: { b: '1.0.0', 'ac-1': '1.0.0', 'ac-2': '1.0.0', 'ac-3': '1.0.0', 'ac-4': '1.0.0' } });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: { a: '1.0.0', 'bc-1': '1.0.0', 'bc-2': '1.0.0', 'bc-3': '1.0.0', 'bc-4': '1.0.0', 'bc-5': '1.0.0' } });
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  assert.deepEqual(result.failed, [], `a dependency cycle terminates (failed=${JSON.stringify(result.failed)})`);
  assert.ok(result.installed.includes('a@1.0.0') && result.installed.includes('b@1.0.0'), 'the cycle installs');
  console.log('  caseL: a→b→a cycle resolves and terminates');
}

// ── Case M: the SAME refused name shared optional+required fails ────────
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const optDeps = { sharp: '^0.34.0', 'xo-1': '1.0.0', 'xo-2': '1.0.0', 'xo-3': '1.0.0', 'xo-4': '1.0.0' };
  const reqDeps = { sharp: '^0.34.0', 'rc-1': '1.0.0', 'rc-2': '1.0.0', 'rc-3': '1.0.0', 'rc-4': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'shared-refusal', dependencies: { ...ok, x: '^1.0.0', y: '^1.0.0' } },
    (name) => {
      if (name === 'x') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optDeps });
        r.optionalDeps = optDeps;
        return r;
      }
      if (name === 'y') return resolvedResult(name, '1.0.0', { dependencies: reqDeps });
      if (name === 'sharp') return rejectedResult('sharp', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('sharp'), `a name reached by both edge kinds is required (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/required package is not supported on Nimbus.*sharp/.test(output), `the summary names it:\n${output}`);
  console.log('  caseM: shared optional/required refusal fails');
}

// ── Case N: a required refusal reports identically across installs ─────
//
// The lockfile written after a partial install must not launder the
// refusal into `Done!` on the next run: the depsJson closure check
// invalidates it (lightningcss is absent from the locked tree), the walk
// re-runs, and the refusal is reported again. Registry-cache writes are
// populated the way a real walk does so the closure check has its input.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const appDeps = { lightningcss: '^1.30.0', 'sc-1': '1.0.0', 'sc-2': '1.0.0', 'sc-3': '1.0.0', 'sc-4': '1.0.0' };
  const cw = (name, version, deps = {}) => ({
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    depsJson: JSON.stringify(deps), peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '',
    binJson: '{}', platformJson: '{}', optionalDepsJson: '{}', fetchedAt: Date.now(),
  });
  const { installer, log } = makeInstaller(
    { name: 'needs-lightningcss', dependencies: { ...ok, 'some-app-dep': '^1.0.0' } },
    (name) => {
      if (name === 'some-app-dep') {
        const r = resolvedResult(name, '1.0.0', { dependencies: appDeps });
        r.cacheWrites = [cw(name, '1.0.0', appDeps)];
        return r;
      }
      if (name === 'lightningcss') return rejectedResult('lightningcss', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
      const r = resolvedResult(name, '1.0.0');
      r.cacheWrites = [cw(name, '1.0.0')];
      return r;
    },
  );
  const first = await installer.install(PROJ);
  assert.ok(first.failed.includes('lightningcss'), `first install fails on the refusal (failed=${JSON.stringify(first.failed)})`);
  log.length = 0;
  const second = await installer.install(PROJ);
  const output = log.join('\n');
  assert.ok(second.failed.includes('lightningcss'), `second install reports the same refusal (failed=${JSON.stringify(second.failed)})`);
  assert.ok(/Lockfile outdated\. Re-resolving/.test(output), `the partial lockfile is invalidated, not trusted:\n${output}`);
  assert.ok(/required package is not supported on Nimbus.*lightningcss/.test(output), `the summary names it again:\n${output}`);
  assert.ok(!/\bDone!/.test(output), 'no success line over a missing required package');
  console.log('  caseN: a partial lockfile re-resolves and re-reports the required refusal');
}

// ── Case O: a complete tree's second install still uses the lockfile ────
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const cw = (name, version) => ({
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    depsJson: '{}', peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '',
    binJson: '{}', platformJson: '{}', optionalDepsJson: '{}', fetchedAt: Date.now(),
  });
  const { installer, log } = makeInstaller(
    { name: 'complete', dependencies: ok },
    (name) => {
      const r = resolvedResult(name, '1.0.0');
      r.cacheWrites = [cw(name, '1.0.0')];
      return r;
    },
  );
  const first = await installer.install(PROJ);
  assert.deepEqual(first.failed, []);
  log.length = 0;
  const second = await installer.install(PROJ);
  const output = log.join('\n');
  assert.deepEqual(second.failed, []);
  assert.ok(/Lockfile valid/.test(output), `a complete lockfile is trusted:\n${output}`);
  assert.ok(/\bDone!/.test(output), 'the second install succeeds from cache');
  console.log('  caseO: a complete tree reuses its lockfile');
}

console.log('npm-install-native-policy: all assertions passed');
