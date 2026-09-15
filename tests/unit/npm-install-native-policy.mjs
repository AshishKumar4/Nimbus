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
import { makeFanoutEnv } from './npm-fanout-test-env.mjs';

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

// A table-listed package resolves like any other and reports the policy
// entry as an advisory — install keeps it (npm parity), the `note:` line
// names the reason.
function advisedResult(name, version, reason, suggest, overrides = {}) {
  const r = resolvedResult(name, version, overrides);
  r.events = [{ type: 'advisory', from: name, reason, suggest, ctx: 'transitive' }];
  return r;
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
  const env = makeFanoutEnv({ root, NM, resultFor });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, { env, ctx, onProgress: (msg) => log.push(msg) });
  return { installer, log, root, harness };
}

// ── Case A: a table-listed root installs with an advisory, exit 0 ──────
//
// sharp is a policy 'fail' entry: it has no Workers-compatible build
// — but real npm installs it, so install keeps it. One `[npm] note:` advisory names the reason; the package is
// on disk, `failed` is empty, the install succeeds.
{
  const { installer, log, root } = makeInstaller(
    { name: 'x', dependencies: { sharp: '^0.34.0', 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' } },
    (name) => resolvedResult(name, name === 'sharp' ? '0.34.0' : '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a table-listed package does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(
    /\[npm\] note: sharp has no Workers-compatible build: .*libvips/.test(output),
    `the advisory line names the reason:\n${output}`,
  );
  assert.ok(result.installed.some((entry) => entry.startsWith('sharp@')), 'sharp installs like any package');
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp is on disk');
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no not-supported summary');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  caseA: sharp installs with an advisory note, exit 0');
}

// ── Case B: an OPTIONAL-only table reject installs, advisory noted ──────
//
// optionalDependencies edges keep their silent-skip contract for
// platform-native bindings, but a table-listed package without os/cpu
// constraints installs — npm parity — with the advisory note.
// Five optional edges keep the resolve layer on the peer-DO topology the
// harness fakes (width >= IN_DO_THRESHOLD), like every other layer in
// this file.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const optShards = { sharp: '^0.34.0', 'opt-1': '^1.0.0', 'opt-2': '^1.0.0', 'opt-3': '^1.0.0', 'opt-4': '^1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'opt-sharp', dependencies: ok },
    (name) => {
      if (name === 'ok-a') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optShards });
        r.optionalDeps = optShards;
        return r;
      }
      if (name === 'sharp') {
        return advisedResult('sharp', '0.34.0', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `an optional-edge advisory does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: sharp has no Workers-compatible build: .*libvips.*Cloudflare Images/.test(output), `the advisory carries reason + hint:\n${output}`);
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'the package installs');
  assert.ok(/\bDone!/.test(output), 'an install with only advisories succeeds');
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no not-supported summary');
  console.log('  caseB: optional-only sharp installs with a note, exit 0');
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
  assert.ok(result.installed.some((entry) => entry.startsWith('sharp@')), `the listed sibling installs too (installed=${JSON.stringify(result.installed)})`);
  assert.ok(/\[npm\] note: sharp has no Workers-compatible build: /.test(output), `the sibling gets its advisory:\n${output}`);
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp is on disk');
  const pkgJson = JSON.parse(root.readFileString(`${PROJ}/package.json`));
  assert.ok(pkgJson.dependencies?.esbuild, 'package.json records the swapped spec');
  assert.ok(pkgJson.dependencies?.sharp, 'package.json records the listed spec (it installed)');
  console.log('  caseC: esbuild→esbuild-wasm and sharp both install; sharp gets a note');
}

// ── Case D: a devDependency advisory installs, marked dev ──────────────
//
// A table-listed devDependency installs like anything else — npm parity
// — and the advisory line says it was declared in devDependencies. The
// supported siblings install alongside.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'dev-sharp', dependencies: ok, devDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a dev-only listed package installs (failed=${JSON.stringify(result.failed)})`);
  assert.ok(
    /\[npm\] note: sharp has no Workers-compatible build \(declared in devDependencies\): /.test(output),
    `the advisory marks it devDependency:\n${output}`,
  );
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp is on disk');
  assert.equal(result.installed.length, 6, 'siblings + sharp install');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  caseD: dev-only sharp installs with a marked advisory, exit 0');
}

// ── Case E: lightningcss under dev-only vite installs with a note ───────
//
// vite@8 (rolldown-based) declares lightningcss as a required
// `dependencies` edge; `npm create vite` lists vite in devDependencies.
// lightningcss is a policy 'fail' entry — no Workers-compatible build —
// but npm installs it, so the install keeps it and logs one advisory.
// `--omit=dev` drops the dev root and its whole subtree either way.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const viteDeps = { lightningcss: '^1.30.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0', 'vc-3': '1.0.0', 'vc-4': '1.0.0' };
  const resultFor = (name) => {
    if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
    if (name === 'lightningcss') return advisedResult('lightningcss', '1.30.0', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
    return resolvedResult(name, '1.0.0');
  };
  const pkgJson = { name: 'vite-app', dependencies: ok, devDependencies: { vite: '^8.0.0' } };

  const first = makeInstaller(pkgJson, resultFor);
  const result = await first.installer.install(PROJ);
  const output = first.log.join('\n');
  assert.deepEqual(result.failed, [], `lightningcss under a dev root installs (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: lightningcss has no Workers-compatible build: /.test(output), `the advisory is logged:\n${output}`);
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no not-supported summary');
  for (const name of ['vite', 'lightningcss']) {
    assert.ok(result.installed.some((entry) => entry.startsWith(`${name}@`)), `${name} installed`);
    assert.ok(first.root.exists(`${NM}/${name}/package.json`), `${name} is on disk`);
  }
  assert.ok(/\bDone!/.test(output), 'the install succeeds');

  // --production / --omit=dev drops the dev root AND its whole subtree.
  const prod = makeInstaller(pkgJson, resultFor);
  const prodResult = await prod.installer.install(PROJ, { production: true });
  const prodOutput = prod.log.join('\n');
  assert.deepEqual(prodResult.failed, [], `--omit=dev installs the rest (failed=${JSON.stringify(prodResult.failed)})`);
  assert.ok(!/lightningcss/.test(prodOutput), 'the listed subtree is never walked under --omit=dev');
  assert.ok(!prod.root.exists(`${NM}/lightningcss/package.json`), 'lightningcss is absent under --omit=dev');
  assert.ok(/\bDone!/.test(prodOutput), 'production install succeeds');
  console.log('  caseE: lightningcss under dev-only vite installs with a note; --omit=dev drops it');
}
// ── Case F: a table-listed dep under a root dependency installs + note ──
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const appDeps = { lightningcss: '^1.30.0', 'sc-1': '1.0.0', 'sc-2': '1.0.0', 'sc-3': '1.0.0', 'sc-4': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'needs-lightningcss', dependencies: { ...ok, 'some-app-dep': '^1.0.0' } },
    (name) => {
      if (name === 'some-app-dep') return resolvedResult(name, '1.0.0', { dependencies: appDeps });
      if (name === 'lightningcss') return advisedResult('lightningcss', '1.30.0', LIGHTNINGCSS.reason, LIGHTNINGCSS.suggest);
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a listed package does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: lightningcss has no Workers-compatible build: .*… try:/.test(output), `the advisory carries the hint:\n${output}`);
  assert.ok(!/\d+ required packages? (is|are) not supported on Nimbus/.test(output), 'no not-supported summary');
  assert.ok(root.exists(`${NM}/lightningcss/package.json`), 'lightningcss installs');
  assert.ok(root.exists(`${NM}/some-app-dep/package.json`), 'the parent installs');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  caseF: lightningcss under a root dependency installs with a note');
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
  const cDeps = { 'native-gate': '^1.0.0', 'cc-1': '1.0.0', 'cc-2': '1.0.0', 'cc-3': '1.0.0', 'cc-4': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'mixed-app', dependencies: { ...ok, a: '^1.0.0' }, devDependencies: { vite: '^8.0.0' } },
    (name) => {
      if (name === 'vite') return resolvedResult(name, '8.0.0', { dependencies: viteDeps });
      if (name === 'a') return resolvedResult(name, '1.0.0', { dependencies: aDeps });
      if (name === 'p1') return resolvedResult(name, '1.0.0', { dependencies: p1Deps });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: bDeps });
      if (name === 'c') return resolvedResult(name, '1.0.0', { dependencies: cDeps });
      if (name === 'native-gate') return rejectedResult('native-gate', 'Requires a native binding for linux-x64.', 'none today');
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('native-gate'), `the later required chain upgrades the refusal (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[skip\].*native-gate — /.test(output), `the skip line is logged once at refusal time:\n${output}`);
  assert.ok(/npm ERR! native-gate: Requires a native binding for linux-x64\./.test(output), `the refusal names the package + reason:\n${output}`);
  assert.ok(/npm ERR! install incomplete.*native-gate/.test(output), `the closing line names it:\n${output}`);
  console.log('  caseG: dev-first ancestor, deeper required chain — end-of-walk closure wins');
}

// ── Case H: a listed dep under an optionalDependencies subtree ─────────
//
// optionalDependencies are never required edges — but a table-listed
// package without os/cpu constraints installs anyway (npm parity); only
// platform-native bindings skip. The advisory note is logged, the
// package is on disk.
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
        return advisedResult('sharp', '0.34.0', 'Native libvips bindings; not portable to Workers.', 'use Cloudflare Images');
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `an advisory under an optional subtree does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: sharp has no Workers-compatible build: /.test(output), `the advisory is logged:\n${output}`);
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp installs under the optional subtree');
  assert.ok(root.exists(`${NM}/y/package.json`), 'the optional package itself installs');
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseH: sharp under an optionalDependencies subtree installs + note, exit 0');
}

// ── Case I: a listed optionalDependencies ROOT installs + note ─────────
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'opt-root', dependencies: ok, optionalDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a listed optional root does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: sharp has no Workers-compatible build: /.test(output), `the advisory is logged:\n${output}`);
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp installs');
  assert.ok(/\bDone!/.test(output), 'the install still succeeds');
  console.log('  caseI: listed optionalDependencies root installs + note, exit 0');
}

// ── Case J: optionalDependencies overrides a dependencies entry ────────
//
// npm semantics: a name in BOTH maps is optional. sharp installs either
// way now — the optional entry matters only for platform bindings —
// and the advisory is logged.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'both-maps', dependencies: { ...ok, sharp: '^0.34.0' }, optionalDependencies: { sharp: '^0.34.0' } },
    (name) => resolvedResult(name, '1.0.0'),
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `a name in both maps does not fail (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/\[npm\] note: sharp has no Workers-compatible build: /.test(output), `the advisory is logged:\n${output}`);
  assert.ok(root.exists(`${NM}/sharp/package.json`), 'sharp installs');
  assert.ok(/\bDone!/.test(output), 'the install succeeds');
  console.log('  caseJ: name in dependencies+optionalDependencies installs + note, exit 0');
}

// ── Case K: optional-first ancestor, required chain deeper — fails ──────
//
// `c` resolves under optional root `optional-root` AND under the required
// chain a→p1→b. A platform-gated dep under c: optional-first ordering
// must not shield a required reach.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const optDeps = { 'optional-root': '^1.0.0', 'xo-1': '1.0.0', 'xo-2': '1.0.0', 'xo-3': '1.0.0', 'xo-4': '1.0.0' };
  const aDeps = { p1: '1.0.0', 'ac-1': '1.0.0', 'ac-2': '1.0.0', 'ac-3': '1.0.0', 'ac-4': '1.0.0' };
  const p1Deps = { b: '1.0.0', 'pc-1': '1.0.0', 'pc-2': '1.0.0', 'pc-3': '1.0.0', 'pc-4': '1.0.0' };
  const cDeps = { 'native-gate': '^1.0.0', 'cc-1': '1.0.0', 'cc-2': '1.0.0', 'cc-3': '1.0.0', 'cc-4': '1.0.0' };
  const bDeps = { c: '1.0.0', 'bc-1': '1.0.0', 'bc-2': '1.0.0', 'bc-3': '1.0.0', 'bc-4': '1.0.0', 'bc-5': '1.0.0' };
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
      if (name === 'c') return resolvedResult(name, '1.0.0', { dependencies: cDeps });
      if (name === 'b') return resolvedResult(name, '1.0.0', { dependencies: bDeps });
      if (name === 'native-gate') return rejectedResult('native-gate', 'Requires a native binding for linux-x64.', 'none today');
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('native-gate'), `the required chain to the shared ancestor wins (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/npm ERR! install incomplete.*native-gate/.test(output), `the closing line names it:\n${output}`);
  console.log('  caseK: optional-first ancestor, deeper required chain — native-gate is required');
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

// ── Case M: the SAME gated name shared optional+required fails ──────────
//
// `native-gate` is reached under x's optionalDependencies AND under y's
// required dependencies. Platform refusals classify at end of walk:
// the required edge makes it required even though the optional edge
// saw it first.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const optDeps = { 'native-gate': '^1.0.0', 'xo-1': '1.0.0', 'xo-2': '1.0.0', 'xo-3': '1.0.0', 'xo-4': '1.0.0' };
  const reqDeps = { 'native-gate': '^1.0.0', 'rc-1': '1.0.0', 'rc-2': '1.0.0', 'rc-3': '1.0.0', 'rc-4': '1.0.0' };
  const { installer, log } = makeInstaller(
    { name: 'shared-refusal', dependencies: { ...ok, x: '^1.0.0', y: '^1.0.0' } },
    (name) => {
      if (name === 'x') {
        const r = resolvedResult(name, '1.0.0', { optionalDependencies: optDeps });
        r.optionalDeps = optDeps;
        return r;
      }
      if (name === 'y') return resolvedResult(name, '1.0.0', { dependencies: reqDeps });
      if (name === 'native-gate') return rejectedResult('native-gate', 'Requires a native binding for linux-x64.', 'none today');
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(result.failed.includes('native-gate'), `a name reached by both edge kinds is required (failed=${JSON.stringify(result.failed)})`);
  assert.ok(/npm ERR! install incomplete.*native-gate/.test(output), `the closing line names it:\n${output}`);
  console.log('  caseM: shared optional/required refusal fails');
}

// ── Case N: a required refusal reports identically across installs ─────
//
// The lockfile written after a partial install must not launder the
// refusal into `Done!` on the next run: the depsJson closure check
// invalidates it (the gated package is absent from the locked tree), the
// walk re-runs, and the refusal is reported again. Registry-cache writes
// are populated the way a real walk does so the closure check has its
// input.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const appDeps = { 'native-gate': '^1.0.0', 'sc-1': '1.0.0', 'sc-2': '1.0.0', 'sc-3': '1.0.0', 'sc-4': '1.0.0' };
  const cw = (name, version, deps = {}) => ({
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    depsJson: JSON.stringify(deps), peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '',
    binJson: '{}', platformJson: '{}', optionalDepsJson: '{}', fetchedAt: Date.now(),
  });
  const { installer, log } = makeInstaller(
    { name: 'needs-gate', dependencies: { ...ok, 'some-app-dep': '^1.0.0' } },
    (name) => {
      if (name === 'some-app-dep') {
        const r = resolvedResult(name, '1.0.0', { dependencies: appDeps });
        r.cacheWrites = [cw(name, '1.0.0', appDeps)];
        return r;
      }
      if (name === 'native-gate') return rejectedResult('native-gate', 'Requires a native binding for linux-x64.', 'none today');
      const r = resolvedResult(name, '1.0.0');
      r.cacheWrites = [cw(name, '1.0.0')];
      return r;
    },
  );
  const first = await installer.install(PROJ);
  assert.ok(first.failed.includes('native-gate'), `first install fails on the refusal (failed=${JSON.stringify(first.failed)})`);
  log.length = 0;
  const second = await installer.install(PROJ);
  const output = log.join('\n');
  assert.ok(second.failed.includes('native-gate'), `second install reports the same refusal (failed=${JSON.stringify(second.failed)})`);
  assert.ok(/Lockfile outdated\. Re-resolving/.test(output), `the partial lockfile is invalidated, not trusted:\n${output}`);
  assert.ok(/npm ERR! install incomplete.*native-gate/.test(output), `the closing line names it again:\n${output}`);
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
// ── Case P: retired 'warn' toolchain entries install like plain JS ──────
//
// wrangler and @cloudflare/vite-plugin were policy 'warn' entries — a
// declared one was refused with a reason. They are plain JavaScript; the
// native shards they pull are refused by the optional-native-binding
// classifier instead. A project that declares them installs them, on
// disk, with the shards skipped and the rest of the tree intact.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const wranglerOptDeps = { 'workerd-1': '1.0.0', 'workerd-2': '1.0.0' };
  const pluginDeps = { miniflare: '1.0.0', 'vc-1': '1.0.0', 'vc-2': '1.0.0' };
  const { installer, log, root } = makeInstaller(
    { name: 'tooling-app', dependencies: { ...ok, wrangler: '^4.0.0', '@cloudflare/vite-plugin': '^1.0.0' } },
    (name) => {
      if (name === 'wrangler') {
        const r = resolvedResult(name, '4.0.0', {
          optionalDependencies: wranglerOptDeps,
          bin: { wrangler: 'bin/wrangler.js' },
        });
        r.optionalDeps = wranglerOptDeps;
        return r;
      }
      if (name === '@cloudflare/vite-plugin') {
        return resolvedResult(name, '1.0.0', { dependencies: pluginDeps });
      }
      if (name === 'workerd-1' || name === 'workerd-2') {
        // The optional native shards wrangler pulls: platform-pinned
        // packages whose only artifact is a native binary. The
        // optional-native-binding classifier refuses them and the parent
        // lives without them.
        return resolvedResult(name, '1.0.0', { os: ['linux'], cpu: ['x64'] });
      }
      return resolvedResult(name, '1.0.0');
    },
  );
  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], `the toolchain installs clean (failed=${JSON.stringify(result.failed)})`);
  for (const name of ['wrangler', '@cloudflare/vite-plugin', 'miniflare']) {
    assert.ok(result.installed.some((entry) => entry.startsWith(`${name}@`)), `${name} installed (installed=${JSON.stringify(result.installed)})`);
    assert.ok(root.exists(`${NM}/${name}/package.json`), `${name} is on disk`);
  }
  for (const name of ['workerd-1', 'workerd-2']) {
    assert.ok(!root.exists(`${NM}/${name}/package.json`), `the native shard ${name} is skipped, not installed`);
    assert.ok(/\[skip\].*workerd/.test(output), `the shard skip is logged:\n${output}`);
  }
  assert.ok(/\bDone!/.test(output), `the install succeeds:\n${output}`);
  console.log('  caseP: wrangler + @cloudflare/vite-plugin install; native shards skipped');
}

// ── Case Q: an npm: alias does not invalidate its own lockfile ─────────
//
// `vliw: npm:react@^19` pins `vliw` to the resolved react version. The
// lockfile answers the alias by presence — re-running satisfiesRange
// against the alias text ("npm:react@^19" parses to nothing) invalidated
// every aliased entry and forced a full re-resolve on every second
// install. The second install must come back "Lockfile valid".
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };
  const cw = (name, version) => ({
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    depsJson: '{}', peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '',
    binJson: '{}', platformJson: '{}', optionalDepsJson: '{}', fetchedAt: Date.now(),
  });
  const { installer, log } = makeInstaller(
    { name: 'alias-app', dependencies: { ...ok, vliw: 'npm:react@^19.0.0' } },
    (name) => {
      const r = resolvedResult(name, name === 'vliw' ? '19.1.0' : '1.0.0');
      r.cacheWrites = [cw(name, name === 'vliw' ? '19.1.0' : '1.0.0')];
      return r;
    },
  );
  const first = await installer.install(PROJ);
  assert.deepEqual(first.failed, []);
  assert.ok(first.installed.includes('vliw@19.1.0'), `the alias installs under its name (installed=${JSON.stringify(first.installed)})`);
  log.length = 0;
  const second = await installer.install(PROJ);
  const output = log.join('\n');
  assert.deepEqual(second.failed, []);
  assert.ok(/Lockfile valid/.test(output), `an aliased spec reuses its lockfile:\n${output}`);
  assert.ok(/\bDone!/.test(output), 'the second install succeeds from cache');
  console.log('  caseQ: an npm: alias reuses its lockfile');
}

// ── Case R: lockfile validity across spec shapes ────────────────────────
//
// A swapped root (esbuild → esbuild-wasm) keeps a semver range and stays
// valid; `latest` stays valid; a changed range invalidates; a git spec —
// which is not a semver range at all — answers presence-only.
{
  const cw = (name, version) => ({
    name, version, tarballUrl: `https://registry.invalid/${name}-${version}.tgz`, integrity: 'sha512-fixture',
    depsJson: '{}', peerDepsJson: '{}', exportsJson: 'null', main: 'index.js', moduleField: '',
    binJson: '{}', platformJson: '{}', optionalDepsJson: '{}', fetchedAt: Date.now(),
  });
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0' };

  // swapped root — second install trusts the lockfile
  {
    const { installer, log } = makeInstaller(
      { name: 'swap-app', dependencies: { ...ok, esbuild: '^0.20.0' } },
      (name) => { const v = name === 'esbuild-wasm' ? '0.20.0' : '1.0.0'; const r = resolvedResult(name, v); r.cacheWrites = [cw(name, v)]; return r; },
    );
    const first = await installer.install(PROJ);
    assert.deepEqual(first.failed, []);
    assert.ok(first.installed.includes('esbuild-wasm@0.20.0'), `the swap target installed (installed=${JSON.stringify(first.installed)})`);
    log.length = 0;
    const second = await installer.install(PROJ);
    assert.ok(/Lockfile valid/.test(log.join('\n')), `a swapped root reuses its lockfile:\n${log.join('\n')}`);
    console.log('  caseR: swapped root stays valid');
  }

  // `latest` root — stays valid
  {
    const { installer, log } = makeInstaller(
      { name: 'latest-app', dependencies: { ...ok, latpkg: 'latest' } },
      (name) => { const v = name === 'latpkg' ? '2.0.0' : '1.0.0'; const r = resolvedResult(name, v); r.cacheWrites = [cw(name, v)]; return r; },
    );
    await installer.install(PROJ);
    log.length = 0;
    await installer.install(PROJ);
    assert.ok(/Lockfile valid/.test(log.join('\n')), `a latest root reuses its lockfile:\n${log.join('\n')}`);
    console.log('  caseR: latest root stays valid');
  }

  // changed root range — invalidates
  {
    const pkgJson = { name: 'chg-app', dependencies: { ...ok, chg: '^1.0.0' } };
    const { installer, log, root } = makeInstaller(
      pkgJson,
      (name) => { const r = resolvedResult(name, name === 'chg' ? '1.4.0' : '1.0.0'); r.cacheWrites = [cw(name, r.pkg.version)]; return r; },
    );
    await installer.install(PROJ);
    pkgJson.dependencies.chg = '^2.0.0';
    root.writeFile(`${PROJ}/package.json`, JSON.stringify(pkgJson));
    log.length = 0;
    const second = await installer.install(PROJ);
    assert.ok(/Lockfile outdated/.test(log.join('\n')), `a changed range invalidates the lockfile:\n${log.join('\n')}`);
    console.log('  caseR: changed range re-resolves');
  }

  // git root — presence-only
  {
    const { installer, log, harness } = makeInstaller(
      { name: 'git-app', dependencies: { ...ok, gitpkg: 'github:user/repo#v1' } },
      (name) => resolvedResult(name, '1.0.0'),
    );
    // A git spec never reaches the resolver — seed the lockfile and
    // registry cache the way a real install left them, then confirm a
    // non-semver range answers presence-only instead of invalidating.
    const entries = new Map();
    for (const name of ['ok-a', 'ok-b', 'ok-c', 'ok-d']) {
      installer.npmCache.putRegistryEntries([cw(name, '1.0.0')]);
      entries.set(name, { name, resolvedVer: '1.0.0', integrity: 'sha512-fixture', depsJson: '{}', hoistedPath: `${NM}/${name}` });
    }
    installer.npmCache.putRegistryEntries([cw('gitpkg', '0.0.0-abc123')]);
    entries.set('gitpkg', {
      name: 'gitpkg', resolvedVer: '0.0.0-abc123', integrity: 'sha512-fixture',
      depsJson: '{}', hoistedPath: `${NM}/gitpkg`,
    });
    installer.npmCache.writeLockfile(PROJ, entries, { storage: harness.ctx.storage });
    const result = await installer.install(PROJ);
    assert.ok(/Lockfile valid/.test(log.join('\n')), `a git root answers presence-only:\n${log.join('\n')}`);
    assert.deepEqual(result.failed, []);
    console.log('  caseR: git root stays valid by presence');
  }
}

console.log('npm-install-native-policy: all assertions passed');
