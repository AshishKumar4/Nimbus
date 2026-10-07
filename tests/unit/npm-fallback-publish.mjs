#!/usr/bin/env bun
/**
 * How the shell's fallback npm (lifo commands/system/npm.ts installTree)
 * publishes a planned tree, under faults injected into the VFS's rename:
 *   - publishing a staged package fails after the package it replaces was
 *     retired: the old one is put back, and the install fails;
 *   - the second publish of an install fails: the first is undone too;
 *   - an undo step fails as well: the retired copy is kept, named, and the
 *     next install restores it;
 *   - an install crashed after retiring a package (its retired copy beside
 *     a missing target): the next install restores it before it plans, and
 *     leaves alone a retired copy whose target is there;
 *   - two installs into one node_modules at once: each runs whole, one
 *     after the other, and package.json keeps both.
 * Each leaves no staging directory behind.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createNpmCommand } from '../../packages/core/src/substrate/lifo/commands/system/npm.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

/** name → version → dependencies. */
const REGISTRY = {
  xa: { '1.0.0': { xc: '^1.0.0' } },
  xc: { '1.0.0': {}, '2.0.0': {} },
  other: { '1.0.0': {} },
};
const tarballs = new Map();
const integrity = new Map();
for (const [name, versions] of Object.entries(REGISTRY)) {
  for (const [version, dependencies] of Object.entries(versions)) {
    const bytes = packageTarball({ 'package/package.json': JSON.stringify({ name, version, dependencies }) });
    tarballs.set(`${name}-${version}.tgz`, bytes);
    integrity.set(`${name}-${version}.tgz`, await sriOf(bytes));
  }
}
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://registry').pathname.slice(1));
  if (tarballs.has(path)) {
    // Paced, so two installs at once overlap: one stages xa, then waits on
    // xc while the other stages and publishes `other`.
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarballs.get(path));
    }, path.startsWith('xc-') ? 400 : path.startsWith('other-') ? 150 : 0);
    return;
  }
  const versions = REGISTRY[path];
  response.writeHead(versions ? 200 : 404, { 'content-type': 'application/json' });
  if (!versions) { response.end('{}'); return; }
  const names = Object.keys(versions);
  response.end(JSON.stringify({
    name: path,
    'dist-tags': { latest: names.at(-1) },
    versions: Object.fromEntries(names.map((version) => [version, {
      name: path, version, dependencies: versions[version],
      dist: { tarball: `${base}/${path}-${version}.tgz`, integrity: integrity.get(`${path}-${version}.tgz`) },
    }])),
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Faults: a rename the predicate picks throws, as a failing disk would.
const realRename = SqliteVFS.prototype.rename;
let fault = null;
SqliteVFS.prototype.rename = function (from, to, ...rest) {
  if (fault?.(String(from), String(to))) throw Object.assign(new Error(`EIO: injected rename ${from} -> ${to}`), { code: 'EIO' });
  return realRename.call(this, from, to, ...rest);
};
const staged = (from) => from.includes('/.nimbus-staging');
const retired = (path) => /\/\.[^/]+-retired-[a-z0-9]+$/.test(path);

async function workspace() {
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
  ws.registry.register('npm', createNpmCommand(ws.registry, undefined, ws.kernel));
  assert.equal((await ws.exec(`printf '%s' '{"name":"app","version":"1.0.0"}' > package.json`)).exitCode, 0);
  const fs = ws.vfs.as(CRED_KERNEL);
  const NM = '/home/user/node_modules';
  const entries = (dir) => (fs.exists(dir) ? fs.readdir(dir).map(({ name }) => name) : []);
  const tree = () => {
    const found = {};
    const walk = (dir, prefix) => {
      for (const name of entries(dir)) {
        if (name.startsWith('.')) continue;
        found[prefix + name] = JSON.parse(fs.readFileString(`${dir}/${name}/package.json`)).version;
        walk(`${dir}/${name}/node_modules`, `${prefix}${name}/node_modules/`);
      }
    };
    walk(NM, '');
    return found;
  };
  return {
    fs, NM,
    npm: (args) => ws.exec(`NPM_REGISTRY=${base} npm ${args}`),
    sh: (line) => ws.exec(`export NPM_REGISTRY=${base}; ${line}`),
    tree,
    dotEntries: () => entries(NM).filter((name) => name.startsWith('.')),
    dependencies: () => JSON.parse(fs.readFileString('/home/user/package.json')).dependencies ?? {},
    close: () => harness.db.close(),
  };
}

try {
  // ── Publishing fails after the old copy is retired ─────────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0')).exitCode, 0);
    fault = (from, to) => staged(from) && to.endsWith('/node_modules/xc');
    const run = await ws.npm('install xc@2.0.0');
    fault = null;
    assert.notEqual(run.exitCode, 0, 'the install fails');
    assert.match(run.stderr, /EIO: .*rename .*nimbus-staging.* -> .*node_modules\/xc'/, 'the publish failure is reported');
    assert.deepEqual(ws.tree(), { xc: '1.0.0' }, 'the retired xc@1 is put back');
    assert.deepEqual(ws.dependencies(), { xc: '^1.0.0' }, 'package.json is unchanged');
    assert.deepEqual(ws.dotEntries(), [], 'no retired copy or staging directory is left');
    ws.close();
  }

  // ── The second publish fails: the first is undone too ─────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xa@1.0.0')).exitCode, 0);
    assert.deepEqual(ws.tree(), { xa: '1.0.0', xc: '1.0.0' });
    fault = (from, to) => staged(from) && to.endsWith('/xa/node_modules/xc');
    const run = await ws.npm('install xa@1.0.0 xc@2.0.0');
    fault = null;
    assert.notEqual(run.exitCode, 0);
    assert.deepEqual(ws.tree(), { xa: '1.0.0', xc: '1.0.0' }, 'root xc@2 is unpublished and xc@1 restored');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }

  // ── An undo step fails: the retired copy is kept, and recovered later ──
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0')).exitCode, 0);
    fault = (from, to) => (staged(from) && to.endsWith('/node_modules/xc')) || (retired(from) && to.endsWith('/node_modules/xc'));
    const run = await ws.npm('install xc@2.0.0');
    fault = null;
    assert.notEqual(run.exitCode, 0);
    const kept = ws.dotEntries().filter((name) => /^\.xc-retired-/.test(name));
    assert.equal(kept.length, 1, `the retired copy is kept: ${ws.dotEntries()}`);
    assert.match(run.stderr, new RegExp(`could not restore .*node_modules/xc; its previous copy is kept at .*${kept[0]}`));
    assert.deepEqual(ws.tree(), {}, 'xc is missing until the next install');
    const rerun = await ws.npm('install');
    assert.equal(rerun.exitCode, 0, rerun.stderr);
    assert.match(rerun.stderr, /restored .*node_modules\/xc/);
    assert.deepEqual(ws.tree(), { xc: '1.0.0' }, 'the next install restores it');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }

  // ── A crash after retiring, then a rerun ────────────────────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0 other@1.0.0')).exitCode, 0);
    // As a crashed install leaves it: xc retired beside its missing target.
    ws.fs.rename(`${ws.NM}/xc`, `${ws.NM}/.xc-retired-crashed1`);
    // And a retired copy whose target is there: not this install's to delete.
    ws.fs.mkdir(`${ws.NM}/.other-retired-elsewhere`, { recursive: true });
    ws.fs.writeFile(`${ws.NM}/.other-retired-elsewhere/package.json`, '{"name":"other","version":"0.9.0"}');
    const rerun = await ws.npm('install');
    assert.equal(rerun.exitCode, 0, rerun.stderr);
    assert.deepEqual(ws.tree(), { other: '1.0.0', xc: '1.0.0' }, 'xc is restored before the plan, not fetched again');
    assert.doesNotMatch(rerun.stdout, /xc@/, 'xc was not planned: the restored copy met its edge');
    assert.deepEqual(ws.dotEntries(), ['.other-retired-elsewhere'], 'a retired copy whose target is there is left alone');
    ws.close();
  }

  // ── Two installs at once ────────────────────────────────────────────────
  {
    const ws = await workspace();
    // Jobs of one shell line run at once (the workspace runs its execs in turn).
    const both = await ws.sh('npm install xa@1.0.0 > a.log 2>&1 & A=$!; npm install other@1.0.0 > b.log 2>&1 & B=$!; wait $A; echo "a=$?"; wait $B; echo "b=$?"');
    assert.match(both.stdout, /a=0\s+b=0/, `${both.stdout}\n${ws.fs.readFileString('/home/user/a.log')}\n${ws.fs.readFileString('/home/user/b.log')}`);
    assert.deepEqual(ws.tree(), { other: '1.0.0', xa: '1.0.0', xc: '1.0.0' });
    assert.deepEqual(ws.dependencies(), { other: '^1.0.0', xa: '^1.0.0' }, 'package.json keeps both');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }
} finally {
  SqliteVFS.prototype.rename = realRename;
  server.close();
}
console.log('npm-fallback-publish: publishing under faults, crashes and concurrency keeps the tree whole');
