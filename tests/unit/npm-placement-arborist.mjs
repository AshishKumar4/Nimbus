#!/usr/bin/env bun
/**
 * Where each package lands in node_modules: npm's own install (arborist, the
 * npm that ships with node) against a local registry, the worker's resolver
 * walk (NpmInstaller over a fake fanout), and the shell's fallback npm (lifo
 * commands/system/npm.ts) against the same registry. The two engines share
 * one placement rule (core _shared/npm-placement.ts); each tree here must
 * give npm's placements and versions:
 *   - a version conflict, nested under the dependent the root copy fails;
 *   - a cycle through the nested copy (c@2 needs d, d needs c@2), which
 *     nests a second copy where the root's does not satisfy;
 *   - a peer the project does not name, installed at root, and one the tree
 *     already meets;
 *   - an optional dependency, and a range a root copy already satisfies.
 * And, installed one command after another into the same project, each
 * against npm's own real install of the same commands:
 *   - several roots named at once (`npm install xa xc@2.0.0`, xa needing
 *     xc@^1), planned together: xc@1 nests under xa;
 *   - a tree already installed (xa and xc@1), then `npm install xa@1
 *     xc@2.0.0`: the reused xa's edges are walked again, so xc@1 nests;
 *   - a replacement that fails its integrity check (bad@1, then bad@2.0.0
 *     whose tarball does not match): the install fails, and bad@1 and
 *     package.json stay as they were;
 *   - an optional dependency (oa→ox) whose own required dependency (oy)
 *     fails: ox is skipped with it, and the install succeeds;
 *   - a name both a dependency and an optional one (ob→oz) that fails: the
 *     optional entry wins, and oz is skipped;
 *   - an optional package already installed (pa→optional px→py) whose
 *     required child is gone and now fails: the warm install skips px's set,
 *     and removes px.
 * npm runs without a package-lock (the fallback keeps none), so it plans
 * from the tree on disk and the registry, as the fallback does.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { resolveVersion } from '../../packages/core/src/_shared/npm-semver.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { kernelInstaller, makeFanoutEnv, cacheRowForPackage } from './npm-fanout-test-env.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

/** name → version → manifest fields (dependencies, peerDependencies, optionalDependencies). */
const REGISTRY = {
  a: { '1.0.0': { dependencies: { c: '^1.0.0' } } },
  b: { '1.0.0': { dependencies: { c: '^2.0.0', shared: '^1.0.0' } } },
  c: { '1.0.0': {}, '2.0.0': { dependencies: { d: '^1.0.0' } } },
  d: { '1.0.0': { dependencies: { c: '^2.0.0' } } },
  host: { '1.0.0': { peerDependencies: { peer: '^1.0.0' }, optionalDependencies: { opt: '^1.0.0' } } },
  peer: { '1.0.0': {}, '2.0.0': {} },
  opt: { '1.0.0': {} },
  shared: { '1.0.0': {}, '1.2.0': {} },
  user: { '1.0.0': { peerDependencies: { shared: '^1.0.0' }, dependencies: { shared: '^1.1.0' } } },
  xa: { '1.0.0': { dependencies: { xc: '^1.0.0' } } },
  xc: { '1.0.0': {}, '2.0.0': {} },
  bad: { '1.0.0': {}, '2.0.0': {} },
  oa: { '1.0.0': { optionalDependencies: { ox: '^1.0.0' } } },
  ox: { '1.0.0': { dependencies: { oy: '^1.0.0' } } },
  oy: { '1.0.0': {} },
  ob: { '1.0.0': { dependencies: { oz: '^1.0.0' }, optionalDependencies: { oz: '^1.0.0' } } },
  oz: { '1.0.0': {} },
  pa: { '1.0.0': { optionalDependencies: { px: '^1.0.0' } } },
  px: { '1.0.0': { dependencies: { py: '^1.0.0' } } },
  py: { '1.0.0': {} },
};
// Tarballs a step of a sequence breaks from then on (their integrity names no bytes).
const brokenNow = new Set();
const NO_BYTES = await sriOf(new TextEncoder().encode('no tarball has these bytes, broken now'));
const ROOT = { a: '^1.0.0', b: '^1.0.0', host: '^1.0.0', shared: '1.0.0', user: '^1.0.0' };

const manifest = (name, version) => ({ name, version, ...REGISTRY[name][version] });
const tarballs = new Map();
for (const [name, versions] of Object.entries(REGISTRY)) {
  for (const version of Object.keys(versions)) {
    tarballs.set(`${name}-${version}.tgz`, packageTarball({ 'package/package.json': JSON.stringify(manifest(name, version)) }));
  }
}
const integrity = new Map();
for (const [file, bytes] of tarballs) integrity.set(file, await sriOf(bytes));
// bad@2.0.0's tarball is not the one its integrity names (and no tarball is,
// so npm's content-addressed cache cannot answer for it).
for (const broken of ['bad-2.0.0.tgz', 'oy-1.0.0.tgz', 'oz-1.0.0.tgz']) {
  integrity.set(broken, await sriOf(new TextEncoder().encode(`no tarball has these bytes: ${broken}`)));
}

// The registry npm and the fallback both read: packuments and tarballs.
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname.slice(1));
  if (tarballs.has(path)) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(tarballs.get(path));
    return;
  }
  const versions = REGISTRY[path];
  if (!versions) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  const names = Object.keys(versions);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    name: path,
    'dist-tags': { latest: names[names.length - 1] },
    versions: Object.fromEntries(names.map((version) => [version, {
      ...manifest(path, version),
      dist: { tarball: `${base}/${path}-${version}.tgz`, integrity: brokenNow.has(`${path}-${version}.tgz`) ? NO_BYTES : integrity.get(`${path}-${version}.tgz`) },
    }])),
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** placement → version, sorted, as each engine left the tree. */
const sorted = (entries) => Object.fromEntries([...entries].sort(([x], [y]) => (x < y ? -1 : 1)));

/** Every package under `dir`'s node_modules, at its placement (a dot entry is npm's own). */
function treeOf(readdir, readFile, exists, dir) {
  const found = [];
  const walk = (at, prefix) => {
    for (const name of readdir(at)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) { walk(`${at}/${name}`, `${prefix}${name}/`); continue; }
      const placement = prefix + name;
      found.push([placement, JSON.parse(readFile(`${at}/${name}/package.json`)).version]);
      if (exists(`${at}/${name}/node_modules`)) walk(`${at}/${name}/node_modules`, `${placement}/node_modules/`);
    }
  };
  if (exists(`${dir}/node_modules`)) walk(`${dir}/node_modules`, '');
  return sorted(found);
}

/** `npm <args>` in `dir`, against the local registry (not spawnSync: it is served from this process). */
const npmIn = (dir, args) => new Promise((resolve) => {
  const child = spawn('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--no-package-lock', '--prefer-online',
    `--registry=${base}/`, `--cache=${join(dir, '.cache')}`], { cwd: dir });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stderr }));
});

/** A fresh workspace whose `npm` is the shell's fallback, its project `app`. */
async function fallbackWorkspace() {
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  assert.equal((await ws.exec(`printf '%s' '{"name":"app","version":"1.0.0"}' > package.json`)).exitCode, 0);
  const fs = ws.vfs.as(CRED_KERNEL);
  return {
    run: (args) => ws.exec(`NPM_REGISTRY=${base} npm ${args.join(' ')}`),
    sh: (line) => ws.exec(line),
    tree: () => treeOf((at) => fs.readdir(at).map(({ name }) => name), (path) => fs.readFileString(path), (path) => fs.exists(path), '/home/user'),
    manifest: () => JSON.parse(fs.readFileString('/home/user/package.json')),
    staged: () => fs.exists('/home/user/node_modules/.nimbus-staging'),
    close: () => harness.db.close(),
  };
}

/**
 * `commands` run in order by npm itself and by the fallback, each in a
 * fresh project: npm's argument lists, and between them changes to the
 * world (`{ remove, break }`: a package removed from node_modules, a tarball
 * broken from then on). For each command, its exit status (as success or
 * failure), then the tree and package.json's dependencies after it.
 */
async function sequence(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-sequence-'));
  const npm = [];
  brokenNow.clear();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    for (const args of commands) {
      if (!Array.isArray(args)) {
        if (args.remove) rmSync(join(dir, 'node_modules', args.remove), { recursive: true, force: true });
        if (args.break) brokenNow.add(args.break);
        continue;
      }
      const { status } = await npmIn(dir, args);
      npm.push({
        ok: status === 0,
        tree: treeOf((at) => readdirSync(at), (path) => readFileSync(path, 'utf8'), existsSync, dir),
        dependencies: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {},
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ws = await fallbackWorkspace();
  const fallback = [];
  brokenNow.clear();
  try {
    for (const args of commands) {
      if (!Array.isArray(args)) {
        if (args.remove) assert.equal((await ws.sh(`rm -rf node_modules/${args.remove}`)).exitCode, 0);
        if (args.break) brokenNow.add(args.break);
        continue;
      }
      const run = await ws.run(args);
      assert.equal(ws.staged(), false, `${args.join(' ')}: no staging directory is left`);
      fallback.push({ ok: run.exitCode === 0, tree: ws.tree(), dependencies: ws.manifest().dependencies ?? {} });
    }
  } finally {
    ws.close();
  }
  return { npm, fallback };
}

try {
  // ── npm ──────────────────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'npm-placement-'));
  let npm;
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: ROOT }));
    // Not spawnSync: the registry npm reads is served from this process.
    const run = await new Promise((resolve) => {
      const child = spawn('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund',
        `--registry=${base}/`, `--cache=${join(dir, '.cache')}`], { cwd: dir });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    npm = sorted(Object.entries(lock.packages).filter(([path]) => path !== '')
      .map(([path, entry]) => [path.replace(/^node_modules\//, ''), entry.version]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The tree exercises what it says it does.
  assert.equal(npm['b/node_modules/c'], '2.0.0', 'the conflict nests');
  assert.equal(npm.peer, '1.0.0', 'the peer is installed at root');
  assert.equal(npm['d/node_modules/c'], '2.0.0', 'the cycle through c@2 nests a second copy under d');
  assert.equal(npm['user/node_modules/shared'], '1.2.0', 'a dependency the root copy fails nests beside a peer the root copy meets');

  // ── the worker's resolver walk ───────────────────────────────────────────
  const worker = await (async () => {
    const resultFor = (name, spec) => {
      const versions = REGISTRY[name] ?? {};
      const version = resolveVersion(Object.keys(versions), spec?.range ?? 'latest');
      const empty = { deps: {}, peerDeps: {}, optionalDeps: {}, cacheWrites: [], messages: [], events: [], packumentBytesDecoded: 0, packumentSource: 'network', cacheStatEvents: [] };
      if (!version) return { ...empty, pkg: null, error: { type: 'unresolved', reason: `no version of ${name} satisfies ${spec?.range}` } };
      const fields = REGISTRY[name][version];
      const pkg = {
        name, version, tarballUrl: `${base}/${name}-${version}.tgz`, integrity: integrity.get(`${name}-${version}.tgz`),
        dependencies: fields.dependencies ?? {}, peerDependencies: fields.peerDependencies, optionalDependencies: fields.optionalDependencies,
        exports: null, main: 'index.js', module: '', bin: {},
      };
      return { ...empty, pkg, deps: pkg.dependencies, peerDeps: pkg.peerDependencies ?? {}, optionalDeps: pkg.optionalDependencies ?? {}, cacheWrites: [cacheRowForPackage(pkg)] };
    };
    const harness = createSqliteVfsTestHarness(new Database(':memory:'));
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const root = vfs.as(CRED_KERNEL);
    root.mkdir('app/node_modules', { recursive: true });
    root.writeFile('app/package.json', JSON.stringify({ name: 'app', dependencies: ROOT }));
    const env = makeFanoutEnv({ root, NM: 'app/node_modules', resultFor });
    const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
    const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
    const result = await installer.install('app', { pid: 1 });
    assert.deepEqual(result.failed, []);
    return sorted([...installer.npmCache.readLockfile('app')].map(([placement, entry]) => [placement, entry.resolvedVer]));
  })();
  assert.deepEqual(worker, npm, "the worker's resolver walk places as npm does");

  // ── the shell's fallback npm ─────────────────────────────────────────────
  const fallback = await (async () => {
    const harness = createSqliteVfsTestHarness();
    const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
    try {
      ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
      assert.equal((await ws.exec(`printf '%s' '${JSON.stringify({ name: 'app', version: '1.0.0', dependencies: ROOT })}' > package.json`)).exitCode, 0);
      const install = await ws.exec(`NPM_REGISTRY=${base} npm install`);
      assert.equal(install.exitCode, 0, install.stderr);
      // Every package under node_modules, at its placement.
      const fs = ws.vfs.as(CRED_KERNEL);
      const found = [];
      const walk = (dir, prefix) => {
        for (const { name } of fs.readdir(dir)) {
          const placement = prefix + name;
          found.push([placement, JSON.parse(fs.readFileString(`${dir}/${name}/package.json`)).version]);
          if (fs.exists(`${dir}/${name}/node_modules`)) walk(`${dir}/${name}/node_modules`, `${placement}/node_modules/`);
        }
      };
      walk('/home/user/node_modules', '');
      return sorted(found);
    } finally {
      harness.db.close();
    }
  })();
  assert.deepEqual(fallback, npm, "the shell's fallback npm places as npm does");

  // ── Several roots, a reused tree, a failed replacement ───────────────────
  const scenarios = {
    'several roots named at once': [['install', 'xa', 'xc@2.0.0']],
    'a reused tree whose root copy is replaced': [['install', 'xa'], ['install', 'xa@1', 'xc@2.0.0']],
    'a replacement that fails its integrity check': [['install', 'bad@1.0.0'], ['install', 'bad@2.0.0']],
    'an optional dependency whose required dependency fails': [['install', 'oa']],
    'a name both a dependency and an optional one': [['install', 'ob']],
    'an optional package already installed whose required child breaks': [['install', 'pa'], { remove: 'py', break: 'py-1.0.0.tgz' }, ['install']],
  };
  const expected = {
    'several roots named at once': { xa: '1.0.0', 'xa/node_modules/xc': '1.0.0', xc: '2.0.0' },
    'a reused tree whose root copy is replaced': { xa: '1.0.0', 'xa/node_modules/xc': '1.0.0', xc: '2.0.0' },
    'a replacement that fails its integrity check': { bad: '1.0.0' },
    'an optional dependency whose required dependency fails': { oa: '1.0.0' },
    'a name both a dependency and an optional one': { ob: '1.0.0' },
    'an optional package already installed whose required child breaks': { pa: '1.0.0' },
  };
  for (const [label, commands] of Object.entries(scenarios)) {
    const { npm: oracle, fallback: steps } = await sequence(commands);
    assert.deepEqual(oracle.at(-1).tree, expected[label], `${label}: npm's own result, as the scenario means it`);
    assert.deepEqual(steps, oracle, `${label}: the fallback's exit statuses, trees and package.json as npm's`);
  }
  console.log(`npm-placement-arborist: ${Object.keys(npm).length} placements, both engines, and ${Object.keys(scenarios).length} install sequences, as npm ${spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
} finally {
  server.close();
}
