#!/usr/bin/env bun
// npm-install-partial-honesty — an install that does not install
// everything it was asked for must say so.
//
// User report (two independent repros, both live):
//   `npm install -g @earendil-works/pi-coding-agent` came back with 27 of
//   119 packages, printed `Done!`, and exited 0. The next command died
//   with `Cannot find module 'which'` — an error that points nowhere near
//   the install that caused it.
//
// The resolver's per-package task returns `pkg: null` both for a
// deliberate policy skip and for a genuine resolution failure (registry
// 4xx, exhausted fetch, malformed packument, no satisfying version). The
// supervisor could not tell them apart, so a failed dependency — and the
// entire subtree hanging off it — silently vanished from the tree and
// from BOTH outcome lists. `failed` stayed empty, so the shell's
// `failed.length > 0 ? 1 : 0` returned 0.
//
// Invariant under test: every dependency the install asked for either
// lands in `installed` or lands in `failed` with a named reason. Nothing
// disappears, and a non-empty `failed` suppresses the success line.
//
// Seam: the peer-DO RPC (`_rpcFanoutExecute`). Everything below it — the
// installer, the VFS, the npm cache, the fanout pool's routing and result
// reassembly — is the real implementation over real SQLite.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { NpmInstaller } from '../../packages/worker/src/npm/installer.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;

/** A resolve-one result for a package that resolves cleanly, no deps. */
function resolvedResult(name, version, overrides = {}) {
  return {
    pkg: {
      name,
      version,
      tarballUrl: `https://registry.invalid/${name}-${version}.tgz`,
      integrity: 'sha512-fixture',
      dependencies: {},
      exports: null,
      main: 'index.js',
      module: '',
      bin: {},
      ...overrides,
    },
    deps: {},
    peerDeps: {},
    optionalDeps: {},
    allPeerDependencies: {},
    cacheWrites: [],
    messages: [],
    events: [],
    packumentBytesDecoded: 0,
    packumentSource: 'network',
    cacheStatEvents: [],
  };
}

/** A resolve-one result for a package the resolver could not resolve. */
function unresolvedResult(reason) {
  return {
    pkg: null,
    deps: {},
    peerDeps: {},
    optionalDeps: {},
    allPeerDependencies: {},
    cacheWrites: [],
    messages: [],
    events: [],
    packumentBytesDecoded: 0,
    packumentSource: 'network',
    cacheStatEvents: [],
    error: { type: 'unresolved', reason },
  };
}

/**
 * Build a project whose package.json lists `deps` and whose node_modules
 * already holds `preinstalled` at the given versions, so the fetch phase
 * has nothing to do and the run exercises resolve → diff → report only.
 */
function makeInstaller(deps, preinstalled, resultFor, installShard) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(PROJ, { recursive: true });
  root.mkdir(NM, { recursive: true });
  root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fixture', dependencies: deps }));
  for (const [name, version] of Object.entries(preinstalled)) {
    root.mkdir(`${NM}/${name}`, { recursive: true });
    root.writeFile(`${NM}/${name}/package.json`, JSON.stringify({ name, version }));
  }

  const log = [];
  const env = {
    LOADER: { get() { return {}; } },
    NIMBUS_SESSION: {
      idFromName(name) { return { toString: () => name, name }; },
      get() {
        return {
          async _rpcFanoutExecute(_fnSource, args) {
            // The same RPC carries both fanouts; the argument shape says
            // which one. Resolve tasks are one package, install tasks are
            // a shard of packages.
            if (args[0] && Array.isArray(args[0].packages)) {
              return { results: args.map((shard) => installShard(shard)) };
            }
            return { results: args.map((spec) => resultFor(spec.name)) };
          },
        };
      },
    },
  };
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = new NpmInstaller(vfs, harness.sql, {
    env,
    ctx,
    onProgress: (msg) => log.push(msg),
  });
  return { installer, log, root };
}

// ── Case 1: a required dependency that cannot be resolved ───────────────
//
// Six top-level deps so the resolver layer takes the peer-DO topology
// (width >= IN_DO_THRESHOLD), which is the path both live repros hit.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const deps = { ...ok, 'ghost-dep': '^2.0.0' };
  const { installer, log } = makeInstaller(deps, ok, (name) =>
    name === 'ghost-dep'
      ? unresolvedResult('registry returned HTTP 404 for ghost-dep')
      : resolvedResult(name, '1.0.0'));

  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(
    result.failed.includes('ghost-dep'),
    `unresolved dependency must be reported as failed (failed=${JSON.stringify(result.failed)})`,
  );
  assert.equal(result.installed.length, 5, 'the resolvable packages still install');
  assert.ok(
    /could not resolve ghost-dep: registry returned HTTP 404/.test(output),
    `the failure must name the package and the reason:\n${output}`,
  );
  assert.ok(
    !/\bDone!/.test(output),
    `a partial install must not print the success line:\n${output}`,
  );
  assert.ok(
    /install incomplete/.test(output) && /ghost-dep/.test(output),
    `the summary must name what is missing:\n${output}`,
  );
  // The shell maps a non-empty `failed` to exit 1 (session/init.ts).
  assert.ok(result.failed.length > 0, 'exit-code contract: failed is non-empty');
  console.log(`  case1: ghost-dep reported, ${result.installed.length} installed, no Done!`);
}

// ── Case 2: resolved metadata that carries no tarball ────────────────────
//
// The diff phase used to `continue` past these, so the package appeared in
// neither list and the install still reported success.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const deps = { ...ok, 'no-tarball': '^1.0.0' };
  const { installer, log } = makeInstaller(deps, ok, (name) =>
    name === 'no-tarball'
      ? resolvedResult(name, '1.0.0', { tarballUrl: '' })
      : resolvedResult(name, '1.0.0'));

  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(
    result.failed.some((entry) => entry.startsWith('no-tarball@')),
    `a package with no tarball must be reported as failed (failed=${JSON.stringify(result.failed)})`,
  );
  assert.ok(
    /no-tarball@1\.0\.0: resolved metadata carries no tarball URL/.test(output),
    `the failure must name the package and the reason:\n${output}`,
  );
  assert.ok(!/\bDone!/.test(output), `a partial install must not print the success line:\n${output}`);
  console.log('  case2: tarball-less package reported instead of dropped');
}

// ── Case 3: a clean install still reports success ────────────────────────
//
// The honesty check must not fire on a complete install, or every green
// run turns red.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0', 'ok-f': '1.0.0' };
  const { installer, log } = makeInstaller(ok, ok, (name) => resolvedResult(name, '1.0.0'));

  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], 'a complete install reports nothing failed');
  assert.equal(result.installed.length, 6, 'every requested package is installed');
  assert.ok(/\bDone! 6 packages/.test(output), `a complete install prints the success line:\n${output}`);
  assert.ok(!/install incomplete/.test(output), 'a complete install does not print the failure summary');
  console.log('  case3: complete install still reports success');
}

// ── Case 4: an OPTIONAL dependency that cannot be resolved is a skip ─────
//
// Platform-specific optional deps 404 as a matter of course (X.5-G G1).
// Those must stay silent skips, not install failures.
// The optional shards are a full layer wide so this layer also takes the
// peer-DO topology, like the layer above it.
{
  const ok = { 'ok-a': '1.0.0', 'ok-b': '1.0.0', 'ok-c': '1.0.0', 'ok-d': '1.0.0', 'ok-e': '1.0.0' };
  const shards = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`native-shard-${i}`, '^1.0.0']),
  );
  const { installer, log } = makeInstaller(ok, ok, (name) => {
    if (name === 'ok-a') {
      const r = resolvedResult(name, '1.0.0', { optionalDependencies: shards });
      r.optionalDeps = shards;
      return r;
    }
    if (name.startsWith('native-shard-')) {
      return unresolvedResult(`registry returned HTTP 404 for ${name}`);
    }
    return resolvedResult(name, '1.0.0');
  });

  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.deepEqual(result.failed, [], 'an unresolvable OPTIONAL dep does not fail the install');
  assert.ok(/\[skip\] native-shard-0/.test(output), `the optional skip is still surfaced:\n${output}`);
  assert.ok(/\bDone!/.test(output), `an install with only optional skips still succeeds:\n${output}`);
  console.log('  case4: optional dep skip stays a skip');
}

// ── Case 5: an install shard that returns short ──────────────────────────
//
// The supervisor folded `perPackage` into installed/failed by iterating
// what came back, so a package a shard never reported on landed in
// neither list — the same silent partial, one phase later.
{
  const deps = Object.fromEntries(
    ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-lost'].map((n) => [n, '1.0.0']),
  );
  const { installer, log } = makeInstaller(
    deps,
    {}, // nothing pre-installed, so every package goes through the fetch fanout
    (name) => resolvedResult(name, '1.0.0'),
    (shard) => ({
      // Drop `pkg-lost` from the shard's verdicts, keeping every other one.
      perPackage: shard.packages
        .filter((p) => p.name !== 'pkg-lost')
        .map((p) => ({
          name: p.name, version: p.version, fileCount: 3,
          bytesWritten: 100, elapsed: 1, warnings: [],
        })),
      elapsed: 1,
      facetCounters: {
        tarballsCompleted: 0, cumulativeBytesDecoded: 0, peakInFlight: 1,
        pipelinedTarballRaceWins: 0, pipelinedTarballRaceLosses: 0,
      },
      cacheStatEvents: [],
    }),
  );

  const result = await installer.install(PROJ);
  const output = log.join('\n');

  assert.ok(
    result.failed.some((entry) => entry.startsWith('pkg-lost@')),
    `a package no shard reported on must be failed (failed=${JSON.stringify(result.failed)})`,
  );
  assert.equal(result.installed.length, 5, 'the reported packages still install');
  assert.ok(
    /pkg-lost@1\.0\.0: install shard returned no result/.test(output),
    `the failure must name the package and the reason:\n${output}`,
  );
  assert.ok(!/\bDone!/.test(output), `a partial install must not print the success line:\n${output}`);
  console.log('  case5: unreported package reported instead of dropped');
}

console.log('npm-install-partial-honesty: all assertions passed');
