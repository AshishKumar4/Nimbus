#!/usr/bin/env bun
// @tier slow — compares 120 seeded registries with real npm installations.
// npm-install-placement-invariant — seeded random registries, each installed
// by npm 10 itself and by the worker's NpmInstaller (the one engine, core
// _shared/npm-arborist, through the real installer over a fake fanout):
// both give the same tree, placement for placement and version for version,
// and fail alike.
//
// npm's tree is not "every edge met by its nearest copy": a later placement
// can prune what an earlier one nested, leaving an edge npm itself does not
// meet. What holds is npm's own result. A tree for which npm makes a link
// (a cycle of incompatible ranges, which it breaks with a symlink to the
// earlier copy) is counted, not compared: the engine nests no deeper than
// MAX_NEST_DEPTH and fails instead. A mismatch prints the registry that
// produced it, so it can be pinned.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { satisfiesRange } from '../../packages/core/src/_shared/npm-semver.ts';
import { kernelInstaller, makeFanoutEnv } from './lib/npm-fanout-test-env.mjs';
import { npmRegistry } from './lib/npm-registry.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';

const PROJ = 'app';
const NM = `${PROJ}/node_modules`;
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const VERSIONS = ['1.0.0', '2.0.0', '3.0.0'];
const RANGES = ['^1.0.0', '^2.0.0', '^3.0.0', '*'];

let seed = 20260921;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

/** A range some published version of `name` meets. */
const pickRange = (registry, name) => pick(RANGES.filter((range) => Object.keys(registry[name]).some((v) => satisfiesRange(v, range))));

function genRegistry() {
  const registry = {};
  for (const name of NAMES) {
    registry[name] = {};
    for (const version of VERSIONS) if (rnd() >= 0.3) registry[name][version] = {};
    if (Object.keys(registry[name]).length === 0) registry[name]['1.0.0'] = {};
  }
  for (const name of NAMES) {
    for (const version of Object.keys(registry[name])) {
      const dependencies = {};
      for (const dep of NAMES) if (dep !== name && rnd() < 0.3) dependencies[dep] = pickRange(registry, dep);
      registry[name][version] = { dependencies, dist: { tarball: `${base}/${name}-${version}.tgz`, integrity: integrity.get(`${name}-${version}.tgz`) } };
    }
  }
  return registry;
}

// The registry npm reads: the run's packuments, and every tarball any run can name.
let current = npmRegistry({});
const tarballs = new Map();
const integrity = new Map();
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname.slice(1));
  const tarball = /^([a-h])-(\d\.0\.0)\.tgz$/.exec(path);
  if (tarball) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(tarballs.get(path));
    return;
  }
  const packument = current.packumentFor(path);
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
for (const name of NAMES) {
  for (const version of VERSIONS) {
    const bytes = packageTarball({ 'package/package.json': JSON.stringify({ name, version }) });
    tarballs.set(`${name}-${version}.tgz`, bytes);
    integrity.set(`${name}-${version}.tgz`, await sriOf(bytes));
  }
}

/** npm's tree for `deps` over `registry`: placement → version, or null where npm makes a link; and whether it succeeded. */
async function npmTree(registry, deps) {
  current = npmRegistry(registry);
  const dir = mkdtempSync(join(tmpdir(), 'npm-fuzz-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fuzz', version: '1.0.0', dependencies: deps }));
    const status = await new Promise((resolve) => {
      const child = spawn('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online',
        `--registry=${base}/`, `--cache=${join(dir, '.cache')}`], { cwd: dir });
      child.stderr.resume();
      child.on('close', resolve);
    });
    if (status !== 0) return { ok: false, tree: null };
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
    if (entries.some(([, entry]) => entry.link === true)) return { ok: true, tree: null };
    return { ok: true, tree: Object.fromEntries(entries.map(([path, entry]) => [path.replace(/^node_modules\//, ''), entry.version]).sort()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The worker's tree for `deps` over `registry`, as its lockfile records it. */
async function workerTree(registry, deps) {
  const { resultFor } = npmRegistry(registry);
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  try {
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const root = vfs.as(CRED_KERNEL);
    root.mkdir(NM, { recursive: true });
    root.writeFile(`${PROJ}/package.json`, JSON.stringify({ name: 'fuzz', dependencies: deps }));
    const env = makeFanoutEnv({ root, NM, resultFor });
    const ctx = { id: { toString: () => 'coordinator-do-id' }, storage: harness.ctx.storage };
    const installer = kernelInstaller(vfs, harness.sql, { env, ctx, onProgress: () => {} });
    const result = await installer.install(PROJ, { pid: 1 });
    const lock = installer.npmCache.readLockfile(PROJ);
    if (result.failed.length > 0) return { ok: false, tree: null };
    return { ok: true, tree: Object.fromEntries([...lock ?? []].map(([placement, entry]) => [placement, entry.resolvedVer]).sort()) };
  } finally {
    harness.db.close();
  }
}

const RUNS = 120;
let nestedTrees = 0;
let linkedTrees = 0;
let compared = 0;
try {
  for (let run = 0; run < RUNS; run++) {
    const registry = genRegistry();
    const deps = {};
    for (const name of NAMES) if (rnd() < 0.5) deps[name] = pickRange(registry, name);
    if (Object.keys(deps).length === 0) deps.a = '*';
    const npm = await npmTree(registry, deps);
    if (npm.ok && npm.tree === null) {
      linkedTrees++;
      continue;
    }
    const engine = await workerTree(registry, deps);
    const detail = `run ${run}\nregistry=${JSON.stringify(registry)}\ndeps=${JSON.stringify(deps)}`;
    assert.equal(engine.ok, npm.ok, `the install succeeds where npm's does: ${detail}`);
    assert.deepEqual(engine.tree, npm.tree, `the tree is npm's: ${detail}`);
    compared++;
    if (Object.keys(npm.tree ?? {}).some((placement) => placement.includes('/node_modules/'))) nestedTrees++;
  }
} finally {
  server.close();
}
assert.ok(nestedTrees > RUNS / 4, `the fuzz exercises nesting (${nestedTrees}/${compared} compared trees nested)`);
console.log(`npm-install-placement-invariant: ${compared} trees as npm's (${nestedTrees} with nesting); ${linkedTrees} npm links a cycle in, not compared`);
