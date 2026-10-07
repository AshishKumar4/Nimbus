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
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
};
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
      dist: { tarball: `${base}/${path}-${version}.tgz`, integrity: integrity.get(`${path}-${version}.tgz`) },
    }])),
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** placement → version, sorted, as each engine left the tree. */
const sorted = (entries) => Object.fromEntries([...entries].sort(([x], [y]) => (x < y ? -1 : 1)));

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
  console.log(`npm-placement-arborist: ${Object.keys(npm).length} placements, both engines as npm ${spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout.trim()}`);
} finally {
  server.close();
}
