#!/usr/bin/env bun
/**
 * The one install engine (core _shared/npm-tree.ts) against npm's own
 * (arborist, the npm that ships with node), over a local registry. Both of
 * its hosts run it: the worker's (NpmInstaller over a fake fanout) and the
 * shell's fallback npm (lifo commands/system/npm.ts).
 *
 * One tree, planned whole: each host's placements and versions are npm's
 * (a version conflict nested under its dependent; a cycle through a nested
 * copy; a peer installed at root, and one the tree already meets; an
 * optional dependency).
 *
 * Then install sequences, one command after another in one project, each
 * against npm's own run of the same commands: after each, both hosts' exit
 * status, tree and package.json are npm's. They cover several roots named
 * at once; a reused tree; a replacement that fails its integrity check (the
 * install fails, and nothing changes); optional dependencies whose own
 * required dependency fails, at resolution or at download, on a fresh
 * install and a warm one (the optional set goes, with a cycle in it); an
 * explicit request an installed copy meets (`xc@latest`, an alias to
 * another package), resolved anyway; a failed optional range beside a
 * required one of the same name; a peer conflicting with the project's own
 * dependency (ERESOLVE, then `--force`), and one the project's range
 * allows; a copy only probed, not kept, pruned; a conflict placed at the
 * highest ancestor it fits; a named optional dependency; a named
 * replacement pruning what it no longer needs; a bare name keeping its
 * declared range; devDependencies over dependencies; sibling order by
 * name; `--save-dev`; an optional-only project whose dependency is missing;
 * a package the lock records but disk has lost; `--omit=optional`,
 * `--omit=peer`, `--no-save`, `--save-exact`, `--prefer-dedupe` (an older
 * copy every edge accepts replacing a newer one), `--strict-peer-deps`; an
 * alias edge met by another package at a version it accepts. And global
 * prefixes, shallow: each top-level package's dependencies and peers
 * beneath it, two packages whose peers conflict, `--omit` exempt, and an
 * install that leaves the rest of the prefix as it is. A spec no registry
 * answers, and an option that changes the tree and is not implemented, are
 * refused on both hosts and change nothing.
 *
 * npm runs without a package-lock (the fallback keeps none), so it plans
 * from the tree on disk and the registry, as the hosts do.
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
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { npmInstallInvocation } from '../../packages/core/src/substrate/lifo/commands/system/npm-install-args.ts';
import { loadNpmConfig } from '../../packages/core/src/substrate/lifo/commands/system/npm-config.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { npmRegistry } from './lib/npm-registry.mjs';
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
  ra: { '1.0.0': {} },
  rb: { '1.0.0': {} },
  fa: { '1.0.0': { optionalDependencies: { fx: '^9.0.0' } } },
  fb: { '1.0.0': { dependencies: { fx: '^1.0.0' } } },
  fx: { '1.0.0': {} },
  ph: { '1.0.0': { peerDependencies: { pp: '^1.0.0' } } },
  pp: { '1.0.0': {}, '2.0.0': {} },
  // oc needs ocm, which no registry has; ocb and occ need each other.
  oc: { '1.0.0': { dependencies: { ocb: '1.0.0', ocm: '1.0.0' } } },
  ocb: { '1.0.0': { dependencies: { occ: '1.0.0' } } },
  occ: { '1.0.0': { dependencies: { ocb: '1.0.0' } } },
  od: { '1.0.0': { dependencies: { odb: '1.0.0' } } },
  odb: { '1.0.0': { dependencies: { odc: '1.0.0' } } },
  odc: { '1.0.0': { dependencies: { odb: '1.0.0' } } },
  qa: { '1.0.0': { dependencies: { qx: '2.0.0' } } },
  qx: { '1.0.0': {}, '2.0.0': {} },
  qt: { '1.0.0': {} },
  na: { '1.0.0': { dependencies: { nc: '1.0.0', nd: '2.0.0' } } },
  nb: { '1.0.0': { dependencies: { nc: '2.0.0' } } },
  nc: { '1.0.0': {}, '2.0.0': { dependencies: { nd: '1.0.0' } } },
  nd: { '1.0.0': {}, '2.0.0': {} },
  ghost: { '1.0.0': {} },
  rr: { '1.0.0': { dependencies: { rq: '1.0.0' } }, '2.0.0': {} },
  rq: { '1.0.0': {} },
  za: { '1.0.0': { dependencies: { zc: '1.0.0' } } },
  zb: { '1.0.0': { dependencies: { zc: '2.0.0' } } },
  zc: { '1.0.0': {}, '2.0.0': {} },
  ga: { '1.0.0': { dependencies: { gb: '1.0.0' } } },
  gb: { '1.0.0': {} },
  gz: { '1.0.0': { dependencies: { gb: '1.0.0' } } },
  // A peer group placed before the dependency of the package that needs it.
  ka: { '1.0.0': { dependencies: { kr: '1.0.0' } } },
  kb: { '1.0.0': { peerDependencies: { kr: '2.0.0' } } },
  kr: { '1.0.0': {}, '2.0.0': {} },
  // Deep peer groups: a peer of a peer, met by what the set loads.
  ma: { '1.0.0': { peerDependencies: { mb: '^1.0.0' } } },
  mb: { '1.0.0': { peerDependencies: { mc: '^1.0.0' } } },
  mc: { '1.0.0': {}, '2.0.0': {} },
  // A peer the dependent also depends on, more narrowly.
  ua: { '1.0.0': { dependencies: { uc: '1.0.0' }, peerDependencies: { uc: '^1.0.0' } } },
  uc: { '1.0.0': {}, '1.5.0': {} },
  // An optional peer: never installed for the package, and it constrains the copy the tree has.
  oph: { '1.0.0': { peerDependencies: { opp: '^1.0.0' }, peerDependenciesMeta: { opp: { optional: true } } } },
  opp: { '1.0.0': {}, '2.0.0': {} },
  // A registry failure for one request of a layer: only that request fails.
  ra1: { '1.0.0': { optionalDependencies: { flaky: '1.0.0' } } },
  // A dev-only dependency, omitted with --omit=dev.
  devtool: { '1.0.0': { dependencies: { devdep: '1.0.0' } } },
  devdep: { '1.0.0': {} },
  // An optional set whose required member fails, with a physical child of its own.
  'pf-s': { '2.0.0': {} },
  'pf-t': { '1.0.0': {}, '2.0.0': {} },
  'pf-o': { '1.0.0': { dependencies: { 'pf-s': '1.0.0' }, optionalDependencies: { 'pf-t': '1.0.0' } } },
  // A package whose archive carries a dependency no registry has.
  'bun-a': { '1.0.0': { dependencies: { 'bun-b': '1.0.0' }, bundleDependencies: ['bun-b'] } },
  // A dependency reached through a version the tree replaces: pruned with the copy that needed it.
  rx: { '1.0.0': { dependencies: { ry: '1.0.0' } }, '2.0.0': {} },
  ry: { '1.0.0': {} },
  // zc: one dependent takes any version, the other only the older one.
  pd1: { '1.0.0': { dependencies: { zc: '>=1.0.0' } } },
  pd2: { '1.0.0': { dependencies: { zc: '1.0.0' } } },
  // An alias edge: met by any copy at a version its range accepts, whatever the package.
  al: { '1.0.0': { dependencies: { xc: 'npm:ra@^1.0.0' } } },
  // Two global packages whose peers conflict.
  gpa: { '1.0.0': { peerDependencies: { gp: '1.0.0' } } },
  gpb: { '1.0.0': { peerDependencies: { gp: '2.0.0' } } },
  gp: { '1.0.0': {}, '2.0.0': {} },
  // A peer conflict that is not the project's own: let through, ERESOLVE with --strict-peer-deps.
  sa: { '1.0.0': { dependencies: { ph: '1.0.0', pp: '2.0.0' } } },
};
// Tarballs whose bytes are not the ones their integrity names (and no
// tarball's are, so npm's content-addressed cache cannot answer for them);
// a step of a sequence breaks more from then on.
const BROKEN = ['bad-2.0.0.tgz', 'oy-1.0.0.tgz', 'oz-1.0.0.tgz'];
// What an archive carries besides its package.json, by tarball: path in the package → content.
const BUNDLED = { 'bun-a-1.0.0.tgz': { 'node_modules/bun-b/package.json': JSON.stringify({ name: 'bun-b', version: '1.0.0' }) } };
const brokenNow = new Set();
const NO_BYTES = await sriOf(new TextEncoder().encode('no tarball has these bytes, broken now'));
const ROOT = { a: '^1.0.0', b: '^1.0.0', host: '^1.0.0', shared: '1.0.0', user: '^1.0.0' };

const manifest = (name, version) => ({ name, version, ...REGISTRY[name][version] });
const tarballs = new Map();
const manifests = new Map();
for (const [name, versions] of Object.entries(REGISTRY)) {
  for (const version of Object.keys(versions)) {
    manifests.set(`${name}-${version}.tgz`, manifest(name, version));
    const extra = Object.fromEntries(Object.entries(BUNDLED[`${name}-${version}.tgz`] ?? {}).map(([path, content]) => [`package/${path}`, content]));
    tarballs.set(`${name}-${version}.tgz`, packageTarball({ 'package/package.json': JSON.stringify(manifest(name, version)), ...extra }));
  }
}
const integrity = new Map();
for (const [file, bytes] of tarballs) integrity.set(file, await sriOf(bytes));
for (const broken of BROKEN) integrity.set(broken, await sriOf(new TextEncoder().encode(`no tarball has these bytes: ${broken}`)));
const isBroken = (file) => BROKEN.includes(file) || brokenNow.has(file);

// The registry npm and the fallback both read: packuments and tarballs.
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname.slice(1));
  if (tarballs.has(path)) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(tarballs.get(path));
    return;
  }
  const packument = registry.packumentFor(path);
  if (!packument) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(packument));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const registry = npmRegistry(Object.fromEntries(Object.entries(REGISTRY).map(([name, versions]) => [
  name, Object.fromEntries(Object.entries(versions).map(([version, fields]) => [version, {
    ...fields,
    get dist() {
      const file = `${name}-${version}.tgz`;
      return { tarball: `${base}/${file}`, integrity: isBroken(file) ? NO_BYTES : integrity.get(file) };
    },
  }])),
])));

/** placement → version, sorted, as each engine left the tree (`name@version` where the package is not the one its placement names: an alias). */
const sorted = (entries) => Object.fromEntries([...entries].sort(([x], [y]) => (x < y ? -1 : 1)));

/** Every package under `dir`'s node_modules, at its placement (a dot entry is npm's own). */
function treeOf(readdir, readFile, exists, dir) {
  const found = [];
  const walk = (at, prefix) => {
    for (const name of readdir(at)) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) { walk(`${at}/${name}`, `${prefix}${name}/`); continue; }
      const placement = prefix + name;
      const pkg = JSON.parse(readFile(`${at}/${name}/package.json`));
      found.push([placement, pkg.name === name ? pkg.version : `${pkg.name}@${pkg.version}`]);
      if (exists(`${at}/${name}/node_modules`)) walk(`${at}/${name}/node_modules`, `${placement}/node_modules/`);
    }
  };
  if (exists(`${dir}/node_modules`)) walk(`${dir}/node_modules`, '');
  return sorted(found);
}
/** What package.json declares, as each engine left it. */
const declared = (pkg) => ({ dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, optionalDependencies: pkg.optionalDependencies ?? {}, peerDependencies: pkg.peerDependencies ?? {} });

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
  const fs = ws.vfs.as(CRED_KERNEL);
  // As the user writes it: the project is theirs.
  const write = async (pkg) => assert.equal((await ws.exec(`printf '%s' '${JSON.stringify({ name: 'app', version: '1.0.0', ...pkg })}' > package.json`)).exitCode, 0);
  await write({});
  return {
    write,
    run: async (args) => (await ws.exec(`NPM_REGISTRY=${base} npm ${args.map((arg) => `'${arg}'`).join(' ')}`)).exitCode === 0,
    remove: async (name, dir = '/home/user') => assert.equal((await ws.exec(`rm -rf ${dir}/node_modules/${name}`)).exitCode, 0),
    tree: (dir = '/home/user') => treeOf((at) => fs.readdir(at).map(({ name }) => name), (path) => fs.readFileString(path), (path) => fs.exists(path), dir),
    declared: () => declared(JSON.parse(fs.readFileString('/home/user/package.json'))),
    leftovers: () => (fs.exists('/home/user/node_modules') ? fs.readdir('/home/user/node_modules').map(({ name }) => name).filter((name) => name.startsWith('.nimbus-')) : []),
    close: () => harness.db.close(),
  };
}

/** A fresh project `dir` the worker's NpmInstaller installs into, over a fake fanout serving REGISTRY. */
function workerProject(dir = 'app') {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const root = vfs.as(CRED_KERNEL);
  root.mkdir(`${dir}/node_modules`, { recursive: true });
  const write = (pkg) => root.writeFile(`${dir}/package.json`, JSON.stringify({ name: 'app', version: '1.0.0', ...pkg }));
  if (dir === 'app') write({});
  const file = (p) => p.tarballUrl.slice(base.length + 1);
  const env = makeFanoutEnv({
    root, NM: `${dir}/node_modules`, resultFor: registry.resultFor,
    failFor: (p) => (isBroken(file(p)) ? `integrity mismatch for ${file(p)}` : null),
    manifestFor: (p) => manifests.get(file(p)),
    filesFor: (p) => BUNDLED[file(p)] ?? {},
  });
  const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
  const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
  return {
    installer, root, write,
    run: async (args, options = {}) => {
      const noFiles = { async exists() { return false; }, async readFileString(path) { throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }); } };
      const invocation = npmInstallInvocation(await loadNpmConfig(noFiles, `/${dir}`, { HOME: '/home/user' }, args));
      try {
        const result = await installer.install(dir, {
          packages: invocation.packages.length > 0 ? invocation.packages : undefined,
          saveDev: invocation.saveDev, saveOptional: invocation.saveOptional, save: invocation.save, savePrefix: invocation.savePrefix,
          force: invocation.force, strictPeerDeps: invocation.strictPeerDeps, legacyPeerDeps: invocation.legacyPeerDeps, preferDedupe: invocation.preferDedupe,
          production: invocation.production, omitOptional: invocation.omitOptional, omitPeer: invocation.omitPeer,
          global: invocation.global,
          ...options,
        });
        return result.failed.length === 0;
      } catch {
        return false;
      }
    },
    remove: async (name) => root.removeRecursive(`${dir}/node_modules/${name}`),
    tree: () => treeOf((at) => root.readdir(at).map(({ name }) => name), (path) => root.readFileString(path), (path) => root.exists(path), dir),
    declared: () => declared(JSON.parse(root.readFileString(`${dir}/package.json`))),
    close: () => harness.db.close(),
  };
}

/**
 * `commands` run in order by npm itself and by each host, each in a fresh
 * project: npm's argument lists, and between them changes to the world
 * (`{ manifest, remove, break }`: package.json's dependencies set, a package
 * removed from node_modules, a tarball broken from then on). For each
 * command, its exit status (as success or failure), then the tree and
 * package.json's dependencies after it.
 */
async function sequence(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-sequence-'));
  const npm = [];
  brokenNow.clear();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    for (const args of commands) {
      if (!Array.isArray(args)) {
        if (args.manifest) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', ...args.manifest }));
        if (args.remove) rmSync(join(dir, 'node_modules', args.remove), { recursive: true, force: true });
        if (args.break) brokenNow.add(args.break);
        continue;
      }
      const { status } = await npmIn(dir, args);
      npm.push({
        ok: status === 0,
        tree: treeOf((at) => readdirSync(at), (path) => readFileSync(path, 'utf8'), existsSync, dir),
        declared: declared(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))),
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const hosts = {};
  for (const [host, make] of [['fallback', fallbackWorkspace], ['worker', async () => workerProject()]]) {
    const project = await make();
    const steps = [];
    brokenNow.clear();
    try {
      for (const args of commands) {
        if (!Array.isArray(args)) {
          if (args.manifest) await project.write(args.manifest);
          if (args.remove) await project.remove(args.remove);
          if (args.break) brokenNow.add(args.break);
          continue;
        }
        const ok = await project.run(args);
        if (project.leftovers) assert.deepEqual(project.leftovers(), [], `${args.join(' ')}: no staging directory or journal is left`);
        steps.push({ ok, tree: project.tree(), declared: project.declared() });
      }
    } finally {
      project.close();
    }
    hosts[host] = steps;
  }
  return { npm, ...hosts };
}

try {
  // ── One tree, planned whole ──────────────────────────────────────────────
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

  const worker = workerProject();
  worker.write({ dependencies: ROOT });
  assert.equal(await worker.run(['install']), true);
  assert.deepEqual(sorted([...worker.installer.npmCache.readLockfile('app')].map(([placement, entry]) => [placement, entry.resolvedVer])), npm, "the worker's plan places as npm does");
  assert.deepEqual(worker.tree(), npm, 'and installs it so');
  worker.close();

  const fallback = await fallbackWorkspace();
  await fallback.write({ dependencies: ROOT });
  assert.equal(await fallback.run(['install']), true);
  assert.deepEqual(fallback.tree(), npm, "the shell's fallback npm places as npm does");
  fallback.close();

  // ── Install sequences ────────────────────────────────────────────────────
  const scenarios = {
    'several roots named at once': [[['install', 'xa', 'xc@2.0.0']], { xa: '1.0.0', 'xa/node_modules/xc': '1.0.0', xc: '2.0.0' }],
    'a reused tree whose root copy is replaced': [[['install', 'xa'], ['install', 'xa@1', 'xc@2.0.0']], { xa: '1.0.0', 'xa/node_modules/xc': '1.0.0', xc: '2.0.0' }],
    'a replacement that fails its integrity check': [[['install', 'bad@1.0.0'], ['install', 'bad@2.0.0']], { bad: '1.0.0' }],
    'an optional dependency whose required dependency fails': [[['install', 'oa']], { oa: '1.0.0' }],
    'a name both a dependency and an optional one': [[['install', 'ob']], { ob: '1.0.0' }],
    'an optional package already installed whose required child breaks': [[['install', 'pa'], { remove: 'py', break: 'py-1.0.0.tgz' }, ['install']], { pa: '1.0.0' }],
    'an explicit tag an installed copy meets': [[['install', 'xc@1.0.0'], ['install', 'xc@latest']], { xc: '2.0.0' }],
    'an explicit alias to another package': [[['install', 'slot@npm:ra@1.0.0'], ['install', 'slot@npm:rb@1.0.0']], { slot: 'rb@1.0.0' }],
    'a failed optional range beside a required one of the same name': [[['install', 'fa', 'fb']], { fa: '1.0.0', fb: '1.0.0', fx: '1.0.0' }],
    "a peer conflicting with the project's own dependency, then --force": [[['install', 'ph@1.0.0', 'pp@2.0.0'], ['install', 'ph@1.0.0', 'pp@2.0.0', '--force']], { ph: '1.0.0', pp: '2.0.0' }],
    "a peer the project's range allows": [[{ manifest: { dependencies: { ph: '1.0.0', pp: '*' } } }, ['install']], { ph: '1.0.0', pp: '1.0.0' }],
    'an optional set with a cycle, a member missing from the registry': [[{ manifest: { optionalDependencies: { oc: '1.0.0' } } }, ['install']], {}],
    'an optional set with a cycle, its tarball broken': [[{ manifest: { optionalDependencies: { od: '1.0.0' } }, break: 'od-1.0.0.tgz' }, ['install']], {}],
    'a copy only probed, not kept, is pruned': [[{ manifest: { dependencies: { qa: '1.0.0', qx: '1.0.0' } } }, ['install'], { manifest: { dependencies: { qa: '1.0.0', qt: '1.0.0' } } }, ['install']], { qa: '1.0.0', 'qa/node_modules/qx': '2.0.0', qt: '1.0.0' }],
    'a conflict placed at the highest ancestor it fits': [[['install', 'na', 'nb']], { na: '1.0.0', nb: '1.0.0', 'nb/node_modules/nc': '2.0.0', 'nb/node_modules/nd': '1.0.0', nc: '1.0.0', nd: '2.0.0' }],
    'a named optional dependency that cannot resolve': [[{ manifest: { optionalDependencies: { ghost: '^9.0.0' } } }, ['install', 'ghost@^9.0.0']], {}],
    'a named replacement prunes what it no longer needs': [[['install', 'rr@1.0.0'], ['install', 'rr@2.0.0']], { rr: '2.0.0' }],
    'a bare name keeps its declared range': [[{ manifest: { dependencies: { xc: '^1.0.0' } } }, ['install', 'xc']], { xc: '1.0.0' }],
    'devDependencies over dependencies': [[{ manifest: { dependencies: { xc: '1.0.0' }, devDependencies: { xc: '2.0.0' } } }, ['install']], { xc: '2.0.0' }],
    'siblings in name order': [[{ manifest: { dependencies: { zb: '1.0.0', za: '1.0.0' } } }, ['install']], { za: '1.0.0', zb: '1.0.0', 'zb/node_modules/zc': '2.0.0', zc: '1.0.0' }],
    '--save-dev': [[['install', '--save-dev', 'xc@1.0.0']], { xc: '1.0.0' }],
    'an optional-only project whose dependency is missing': [[{ manifest: { optionalDependencies: { nosuch: '1.0.0' } } }, ['install']], {}],
    'a package the lock records but disk has lost': [[['install', 'xa@1.0.0'], { remove: 'xc' }, ['install', 'xa@1.0.0']], { xa: '1.0.0', xc: '1.0.0' }],
    'a peer group placed before the dependency that conflicts with it': [[{ manifest: { dependencies: { ka: '1.0.0', kb: '1.0.0' } } }, ['install']], { ka: '1.0.0', 'ka/node_modules/kr': '1.0.0', kb: '1.0.0', kr: '2.0.0' }],
    'a peer of a peer, placed with the set': [[['install', 'ma']], { ma: '1.0.0', mb: '1.0.0', mc: '1.0.0' }],
    'a peer the dependent also depends on': [[{ manifest: { dependencies: { ua: '1.0.0', uc: '1.5.0' } } }, ['install']], { ua: '1.0.0', 'ua/node_modules/uc': '1.0.0', uc: '1.5.0' }],
    'an optional peer is not installed for its package': [[['install', 'oph']], { oph: '1.0.0' }],
    'an optional peer constrains the copy the tree has': [[{ manifest: { dependencies: { oph: '1.0.0', opp: '2.0.0' } } }, ['install'], ['install', 'oph@1.0.0', 'opp@2.0.0', '--force']], { oph: '1.0.0', opp: '2.0.0' }],
    '--legacy-peer-deps installs no peers': [[['install', '--legacy-peer-deps', 'ph@1.0.0', 'pp@2.0.0']], { ph: '1.0.0', pp: '2.0.0' }],
    'an optional dependency missing from the registry': [[['install', 'ra1']], { ra1: '1.0.0' }],
    '--omit=dev': [[{ manifest: { dependencies: { xc: '1.0.0' }, devDependencies: { devtool: '1.0.0' } } }, ['install', '--omit=dev']], { xc: '1.0.0' }],
    'a named devDependency with --omit=dev is saved, not installed': [[['install', '-D', 'xc@1.0.0', '--omit=dev']], {}],
    'a dependency also a devDependency with --omit=dev': [[{ manifest: { dependencies: { xc: '1.0.0' }, devDependencies: { xc: '2.0.0' } } }, ['install', '--omit=dev']], {}],
    'an inferred dev save updates a peer range it no longer meets': [[{ manifest: { devDependencies: { xc: '^1.0.0' }, peerDependencies: { xc: '^1.0.0' } } }, ['install', 'xc@2.0.0']], { xc: '2.0.0' }],
    'an optional set takes its physical children': [[{ manifest: { dependencies: { 'pf-s': '2.0.0', 'pf-t': '2.0.0' }, optionalDependencies: { 'pf-o': '1.0.0' } } }, ['install']], { 'pf-s': '2.0.0', 'pf-t': '2.0.0' }],
    'a bundled dependency comes in its archive': [[['install', 'bun-a'], ['install']], { 'bun-a': '1.0.0', 'bun-a/node_modules/bun-b': '1.0.0' }],
    'a replaced copy takes what only it needed': [[['install', 'rx@1.0.0'], ['install', 'rx@2.0.0']], { rx: '2.0.0' }],
    '--omit=optional': [[['install', 'host@1.0.0', '--omit=optional']], { host: '1.0.0', peer: '1.0.0' }],
    '--omit=peer': [[['install', 'ph@1.0.0', '--omit=peer']], { ph: '1.0.0' }],
    '--no-save': [[['install', 'xc@1.0.0', '--no-save']], { xc: '1.0.0' }],
    '--save-exact': [[['install', 'xc@^1.0.0', '--save-exact']], { xc: '1.0.0' }],
    'a newer copy one dependent needs, beside one that takes any': [[['install', 'pd1'], ['install', 'pd2']], { pd1: '1.0.0', pd2: '1.0.0', 'pd2/node_modules/zc': '1.0.0', zc: '2.0.0' }],
    '--prefer-dedupe replaces it with the older copy both accept': [[['install', 'pd1'], ['install', 'pd2', '--prefer-dedupe']], { pd1: '1.0.0', pd2: '1.0.0', zc: '1.0.0' }],
    "an alias edge met by another package's copy": [[['install', 'xc@1.0.0'], ['install', 'al']], { al: '1.0.0', xc: '1.0.0' }],
    "another package's peer conflict is let through": [[['install', 'sa']], { ph: '1.0.0', pp: '1.0.0', sa: '1.0.0', 'sa/node_modules/pp': '2.0.0' }],
    "another package's peer conflict with --strict-peer-deps is ERESOLVE": [[['install', 'sa', '--strict-peer-deps']], {}],
  };
  for (const [label, [commands, expected]] of Object.entries(scenarios)) {
    const { npm: oracle, fallback: shell, worker: engine } = await sequence(commands);
    assert.deepEqual(oracle.at(-1).tree, expected, `${label}: npm's own result, as the scenario means it`);
    assert.deepEqual(shell, oracle, `${label}: the fallback's exit statuses, trees and package.json as npm's`);
    assert.deepEqual(engine, oracle, `${label}: the worker's exit statuses, trees and package.json as npm's`);
  }

  // ── Global prefixes: npm's shallow layout ────────────────────────────────
  // Each step `npm install -g <args>`, or `{ remove }` a placement under the
  // prefix's node_modules; after each, the exit status and the prefix's tree.
  const globals = {
    "each package's dependencies beneath it": [[['ga'], ['gz']], { ga: '1.0.0', 'ga/node_modules/gb': '1.0.0', gz: '1.0.0', 'gz/node_modules/gb': '1.0.0' }],
    'two packages whose peers conflict': [[['gpa'], ['gpb']], { gpa: '1.0.0', 'gpa/node_modules/gp': '1.0.0', gpb: '1.0.0', 'gpb/node_modules/gp': '2.0.0' }],
    '--omit leaves out nothing': [[['host@1.0.0', '--omit=optional', '--omit=peer']], { host: '1.0.0', 'host/node_modules/opt': '1.0.0', 'host/node_modules/peer': '1.0.0' }],
    'the rest of the prefix is as it was': [[['ga'], { remove: 'ga/node_modules/gb' }, ['gz']], { ga: '1.0.0', gz: '1.0.0', 'gz/node_modules/gb': '1.0.0' }],
  };
  for (const [label, [steps, expected]] of Object.entries(globals)) {
    const prefix = mkdtempSync(join(tmpdir(), 'npm-global-'));
    const oracle = [];
    try {
      for (const step of steps) {
        if (!Array.isArray(step)) {
          rmSync(join(prefix, 'lib/node_modules', step.remove), { recursive: true, force: true });
          continue;
        }
        const { status } = await npmIn(prefix, ['install', '-g', `--prefix=${prefix}`, ...step]);
        oracle.push({ ok: status === 0, tree: treeOf((at) => readdirSync(at), (path) => readFileSync(path, 'utf8'), existsSync, join(prefix, 'lib')) });
      }
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
    assert.deepEqual(oracle.at(-1).tree, expected, `${label}: npm's own global layout`);
    const shell = await fallbackWorkspace();
    const engine = workerProject('g/lib');
    try {
      const shellSteps = [];
      const engineSteps = [];
      for (const step of steps) {
        if (!Array.isArray(step)) {
          await shell.remove(step.remove, '/home/user/g/lib');
          await engine.remove(step.remove);
          continue;
        }
        shellSteps.push({ ok: await shell.run(['install', '-g', '--prefix=/home/user/g', ...step]), tree: shell.tree('/home/user/g/lib') });
        engineSteps.push({ ok: await engine.run(['install', '-g', ...step]), tree: engine.tree() });
      }
      assert.deepEqual(shellSteps, oracle, `${label}: the fallback's global installs as npm's`);
      assert.deepEqual(engineSteps, oracle, `${label}: the worker's global installs as npm's`);
    } finally {
      shell.close();
      engine.close();
    }
  }

  // ── What npm has and this does not: refused, and nothing changes ─────────
  {
    const shell = await fallbackWorkspace();
    const engine = workerProject();
    try {
      for (const spec of ['git+https://example.invalid/x.git', 'file:../x', 'https://example.invalid/x.tgz']) {
        assert.equal(await shell.run(['install', `x@${spec}`]), false, `the fallback refuses ${spec}`);
        assert.equal(await engine.run(['install', `x@${spec}`]), false, `the worker refuses ${spec}`);
      }
      for (const option of ['--install-strategy=nested', '--global-style', '--dry-run', '--package-lock-only', '--before=2020-01-01', '--os=darwin']) {
        assert.equal(await shell.run(['install', 'xc@1.0.0', option]), false, `${option} is refused`);
      }
      assert.deepEqual(shell.tree(), {}, 'nothing is installed');
      assert.deepEqual(engine.tree(), {});
      assert.deepEqual(shell.declared(), declared({}), 'nothing is saved');
      assert.deepEqual(engine.declared(), declared({}));
    } finally {
      shell.close();
      engine.close();
    }
  }
  console.log(`npm-placement-arborist: ${Object.keys(npm).length} placements, both hosts, ${Object.keys(scenarios).length} install sequences and ${Object.keys(globals).length} global prefixes, as npm ${spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
} finally {
  server.close();
}
