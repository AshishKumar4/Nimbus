#!/usr/bin/env bun
/**
 * How the shell's fallback npm (lifo commands/system/npm.ts installTree)
 * publishes a planned tree under its journal, with faults injected into the
 * VFS's rename:
 *   - publishing a staged package fails after the package it replaces was
 *     retired: the old one is put back, and the install fails;
 *   - the second publish of an install fails: the first is undone too;
 *   - a retirement moves everything and then fails (the filesystem says so,
 *     leaving residue where the package was): the undo puts the complete
 *     copy back over the residue;
 *   - an undo step fails as well: the retired copy is kept, named, and the
 *     next install restores it from the journal;
 *   - an install crashed mid-publication (its journal uncommitted, a
 *     package half-published over the one it retired): the next install
 *     undoes it before it plans, and leaves alone a retired-looking copy the
 *     journal does not name;
 *   - a replacement bundling its own node_modules: the kept nested package
 *     the old one held is carried into the new one;
 *   - Ctrl-C while the install fetches: nothing changes, and no staging
 *     directory is left;
 *   - two installs into one node_modules at once: each runs whole, one
 *     after the other, and package.json keeps both; also when they name
 *     the tree by two paths (a global prefix and a symlink to it).
 * Each leaves no staging directory or journal behind once it is whole.
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
  // bp@2 bundles a package of its own in its node_modules.
  bp: { '1.0.0': { bc: '1.0.0' }, '2.0.0': { bc: '1.0.0' } },
  bc: { '1.0.0': {}, '2.0.0': {} },
};
const BUNDLED = { 'bp-2.0.0.tgz': { 'package/node_modules/bz/package.json': '{"name":"bz","version":"1.0.0"}' } };
const tarballs = new Map();
const integrity = new Map();
for (const [name, versions] of Object.entries(REGISTRY)) {
  for (const [version, dependencies] of Object.entries(versions)) {
    const bytes = packageTarball({ 'package/package.json': JSON.stringify({ name, version, dependencies }), ...BUNDLED[`${name}-${version}.tgz`] });
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

// Faults: a rename the predicate picks throws, as a failing disk would;
// one `moved` picks makes the rename, leaves residue where it came from,
// and then throws, saying it moved everything (renamed: 'all').
const realRename = SqliteVFS.prototype.rename;
let fault = null;
let moved = null;
SqliteVFS.prototype.rename = function (from, to, ...rest) {
  if (fault?.(String(from), String(to))) throw Object.assign(new Error(`EIO: injected rename ${from} -> ${to}`), { code: 'EIO' });
  if (moved?.(String(from), String(to))) {
    moved = null;
    realRename.call(this, from, to, ...rest);
    this.as(CRED_KERNEL).mkdir(`${from}/lib`, { recursive: true });
    this.as(CRED_KERNEL).writeFile(`${from}/lib/residue.js`, '');
    throw Object.assign(new Error(`EIO: injected source cleanup ${from}`), { code: 'EIO', renamed: 'all' });
  }
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
    npm: (args, options) => ws.exec(`NPM_REGISTRY=${base} npm ${args}`, options),
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
    assert.match(run.stderr, new RegExp(`could not restore .*node_modules/xc; its copy is kept at .*${kept[0]}`));
    assert.deepEqual(ws.tree(), {}, 'xc is missing until the next install');
    assert.ok(ws.dotEntries().includes('.nimbus-install-journal'), 'the journal says what to undo');
    const rerun = await ws.npm('install');
    assert.equal(rerun.exitCode, 0, rerun.stderr);
    assert.match(rerun.stderr, /restored .*node_modules\/xc/);
    assert.deepEqual(ws.tree(), { xc: '1.0.0' }, 'the next install restores it');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }

  // ── A retirement that moves everything, then fails ──────────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0')).exitCode, 0);
    moved = (from, to) => from.endsWith('/node_modules/xc') && retired(to);
    const run = await ws.npm('install xc@2.0.0');
    moved = null;
    assert.notEqual(run.exitCode, 0);
    assert.doesNotMatch(run.stderr, /could not (tell|restore)/, `the filesystem said what the rename did, and the undo used it:\n${run.stderr}`);
    assert.deepEqual(ws.tree(), { xc: '1.0.0' }, 'the complete retired copy is put back');
    assert.equal(ws.fs.exists(`${ws.NM}/xc/lib/residue.js`), false, 'over the residue');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }

  // ── A crash mid-publication, then a rerun ───────────────────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0 other@1.0.0')).exitCode, 0);
    // As a crashed install leaves it: xc retired, xc@2 half-published over
    // it from staging, and the journal uncommitted.
    ws.fs.rename(`${ws.NM}/xc`, `${ws.NM}/.xc-retired-crashed1`);
    ws.fs.mkdir(`${ws.NM}/.nimbus-staging-crashed1/0/lib`, { recursive: true });
    ws.fs.writeFile(`${ws.NM}/.nimbus-staging-crashed1/0/lib/rest.js`, '');
    ws.fs.mkdir(`${ws.NM}/xc`, { recursive: true });
    ws.fs.writeFile(`${ws.NM}/xc/package.json`, '{"name":"xc","version":"2.0.0"}');
    ws.fs.writeFile(`${ws.NM}/.nimbus-install-journal`, JSON.stringify({
      run: 'crashed1',
      committed: false,
      steps: [
        { kind: 'retire', from: `${ws.NM}/xc`, to: `${ws.NM}/.xc-retired-crashed1`, state: 'done' },
        { kind: 'publish', from: `${ws.NM}/.nimbus-staging-crashed1/0`, to: `${ws.NM}/xc`, state: 'begun' },
      ],
    }));
    // And a retired-looking copy the journal does not name: not this install's to touch.
    ws.fs.mkdir(`${ws.NM}/.other-retired-elsewhere`, { recursive: true });
    ws.fs.writeFile(`${ws.NM}/.other-retired-elsewhere/package.json`, '{"name":"other","version":"0.9.0"}');
    const rerun = await ws.npm('install');
    assert.equal(rerun.exitCode, 0, rerun.stderr);
    assert.deepEqual(ws.tree(), { other: '1.0.0', xc: '1.0.0' }, 'xc@1 is restored before the plan, not fetched again');
    assert.doesNotMatch(rerun.stdout, /xc@/, 'xc was not planned: the restored copy met its edge');
    assert.deepEqual(ws.dotEntries(), ['.other-retired-elsewhere'], 'what the journal does not name is left alone');
    ws.close();
  }

  // ── A replacement bundling its own node_modules ─────────────────────────
  {
    const ws = await workspace();
    // bp@1 needs bc@1, and the project bc@2: bc@1 nests under bp.
    assert.equal((await ws.npm('install bp@1.0.0 bc@2.0.0')).exitCode, 0);
    assert.deepEqual(ws.tree(), { bc: '2.0.0', bp: '1.0.0', 'bp/node_modules/bc': '1.0.0' });
    const run = await ws.npm('install bp@2.0.0');
    assert.equal(run.exitCode, 0, run.stderr);
    assert.deepEqual(ws.tree(), { bc: '2.0.0', bp: '2.0.0', 'bp/node_modules/bc': '1.0.0', 'bp/node_modules/bz': '1.0.0' },
      'the kept bc@1 is carried into bp@2, beside what it bundles');
    assert.deepEqual(ws.dotEntries(), []);
    ws.close();
  }

  // ── Ctrl-C while the install fetches ─────────────────────────────────────
  {
    const ws = await workspace();
    assert.equal((await ws.npm('install xc@1.0.0')).exitCode, 0);
    const controller = new AbortController();
    // xc's tarball is paced: the stop comes while it is fetched.
    setTimeout(() => controller.abort(), 150);
    const run = await ws.npm('install xc@2.0.0 other@1.0.0', { signal: controller.signal });
    assert.notEqual(run.exitCode, 0, 'the stopped install fails');
    assert.deepEqual(ws.tree(), { xc: '1.0.0' }, 'nothing is published');
    assert.deepEqual(ws.dependencies(), { xc: '^1.0.0' }, 'nor saved');
    assert.deepEqual(ws.dotEntries(), [], 'and its staging directory is gone');
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

  // ── Two global installs into one tree, by two paths to it ──────────────
  {
    const ws = await workspace();
    assert.equal((await ws.sh('mkdir -p /home/user/p && ln -s /home/user/p /home/user/l')).exitCode, 0);
    // The second starts while the first waits on xc, its xa staged.
    const both = await ws.sh('npm install -g --prefix=/home/user/p xa@1.0.0 > a.log 2>&1 & A=$!; sleep 0.2; npm install -g --prefix=/home/user/l other@1.0.0 > b.log 2>&1 & B=$!; wait $A; echo "a=$?"; wait $B; echo "b=$?"');
    assert.match(both.stdout, /a=0\s+b=0/, `${both.stdout}\n${ws.fs.readFileString('/home/user/a.log')}\n${ws.fs.readFileString('/home/user/b.log')}`);
    const modules = (ws.fs.readdir('/home/user/p/lib/node_modules').map(({ name }) => name)).sort();
    assert.deepEqual(modules, ['other', 'xa'], 'one tree holds both installs, and nothing else');
    assert.ok(ws.fs.exists('/home/user/p/lib/node_modules/xa/node_modules/xc/package.json'), "xa's dependency beneath it, npm's global layout");
    ws.close();
  }
} finally {
  SqliteVFS.prototype.rename = realRename;
  server.close();
}
console.log('npm-fallback-publish: publishing under faults, crashes and concurrency keeps the tree whole');
