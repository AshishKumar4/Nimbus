#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { RecallRequired } from '../../packages/core/src/vfs/recall.ts';
import { prebundleSliceBytes } from '../../packages/core/src/runtime/prebundle-slice.ts';
import { PrebundlePool } from '../../packages/worker/src/facets/prebundle-pool.ts';
import { buildPrebundle, storedPrebundle } from '../../packages/worker/src/npm/browser-prebundle.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { PrebundleInputs, PrebundlePlanChanged, materializePrebundleSlice, planSliceForSpecifierWithCap } from '../../packages/worker/src/npm/pre-bundle-facet.ts';
import { launchSession } from './lib/facet-launch-harness.mjs';
import { namedFacetPlatform } from './lib/named-facet-platform.mjs';
import { runScenarios } from './lib/resident-body.mjs';

function fixture(name, { field = 'main', synthetic = false, unrelated = false, churnFloor = false } = {}) {
  const session = launchSession();
  const fs = session.vfs.as(CRED_KERNEL);
  const root = 'home/user/app';
  const pkg = root + '/node_modules/pkg';
  const source = churnFloor ? pkg + '/impl' : pkg;
  const entry = (name) => (churnFloor ? 'impl/' : '') + name;
  const manifest = (entry) => JSON.stringify({ name: 'pkg', type: 'module', [field]: field === 'exports' ? './' + entry : entry });
  for (const dir of ['pkg', 'blocker', 'other', '.nimbus-synthetic']) fs.mkdir(root + '/node_modules/' + dir, { recursive: true });
  fs.mkdir(source, { recursive: true });
  fs.writeFile(pkg + '/package.json', manifest(entry('index-a.js')));
  fs.writeFile(source + '/index-a.js', synthetic ? 'export { X } from "./a.js";' : 'export const X = "A";');
  fs.writeFile(source + '/index-b.js', synthetic ? 'export { X } from "./b.js";' : 'export const X = "B";');
  fs.writeFile(source + '/a.js', 'export const X = "A";');
  fs.writeFile(source + '/b.js', 'export const X = "B";');
  fs.writeFile(root + '/node_modules/blocker/package.json', '{"main":"index.js"}');
  fs.writeFile(root + '/node_modules/blocker/index.js', 'export const blocker = 1;');
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const submitted = Promise.withResolvers();
  const specs = [];
  let submissions = 0;
  class Compiler {
    async warm() {}
    async prebundle(spec) {
      if (spec.specifier === 'blocker') { entered.resolve(); await finish.promise; }
      else specs.push(spec);
      const entry = spec.slice.find((item) => !item.isDir && item.path.replace(/^\/+/, '') === spec.entryPath.replace(/^\/+/, ''));
      assert.ok(entry, `entry ${spec.entryPath} is in the transferred slice`);
      return { specifier: spec.specifier, ok: true, esmCode: new TextDecoder().decode(entry.bytes), elapsed: 0, warnings: [] };
    }
  }
  const platform = namedFacetPlatform({ id: name, classFor: () => Compiler,
    invoke(_name, method, args, instance) {
      const transferred = structuredClone(args);
      args.length = 0;
      return instance.then((target) => target[method](...transferred));
    },
  });
  const real = new PrebundlePool(platform.env, platform.ctx);
  const pool = { async acquire(signal) {
    const acquired = await real.acquire(signal);
    return { prebundle(task) {
      const pending = acquired.prebundle(task);
      if (task.specifier === 'pkg') {
        submissions++;
        if (unrelated && submissions <= 2) {
          fs.writeFile(root + '/node_modules/other/entry.js', `export const write = ${submissions};`);
          fs.writeFile(root + '/node_modules/.nimbus-synthetic/other.entry.js', `export const write = ${submissions};`);
        }
        if (churnFloor && submissions <= 2) advanceFloor(fs, source + '/package.json', `queued-${synthetic}-${submissions}`);
        submitted.resolve();
      }
      return pending;
    } };
  } };
  const context = { vfs: fs, root, cache: new NpmCache(session.disk.sql), pool, parse: async (_path, source) => source,
    esbuild: new EsbuildService(undefined, {}), serviceFallback: false, running: true };
  const barrel = synthetic ? { pkgName: 'pkg', fileCount: 1000, names: new Set(['X']), inputHash: 'x' } : null;
  return { fs, pkg, context, barrel, specs, submissions: () => submissions,
    move: () => fs.writeFile(pkg + '/package.json', manifest(entry('index-b.js'))),
    async queued(change) {
      const blocker = buildPrebundle(context, 'blocker', null, (code) => code);
      await entered.promise;
      const target = buildPrebundle(context, 'pkg', barrel, (code) => code);
      await submitted.promise;
      try { change?.(); } finally { finish.resolve(); }
      assert.equal((await blocker).kind, 'built');
      return target;
    },
  };
}

function advanceFloor(fs, absent, name) {
  const before = fs.revision(absent);
  const root = 'home/user/unrelated-churn/' + name;
  const wide = 'd'.repeat(200);
  for (let i = 0; i < 2400; i++) fs.mkdir(`${root}/${wide}${i}/child`, { recursive: true });
  assert.equal(fs.exists(absent), false, 'the consulted missing path is still absent');
  assert.ok(fs.revision(absent) > before, 'unrelated directory stamps exceeded the real VFS budget and advanced its floor');
}

async function entryMoves(field, synthetic) {
  const h = fixture(`queued-${field}-${synthetic}`, { field, synthetic });
  const result = await h.queued(h.move);
  assert.equal(result.kind, 'built', JSON.stringify(result));
  assert.equal(result.changed, false);
  assert.match(result.served, synthetic ? /b\.js/ : /"B"/,
    'a queued manifest change restarts both entry resolution and synthetic generation');
  assert.equal(h.specs.length, 1, 'the invalidated plan never reaches RPC');
  if (!synthetic) assert.match(h.specs[0].entryPath, /index-b\.js$/);
  assert.equal((await storedPrebundle(h.context, 'pkg', h.barrel))?.esmCode, result.served,
    'the current manifest key cannot cache output from the previous entry');
}

async function unrelatedWrites(synthetic) {
  const h = fixture(`unrelated-node-modules-${synthetic}`, { synthetic, unrelated: true });
  const result = await h.queued();
  assert.equal(result.kind, 'built', JSON.stringify(result));
  assert.equal(result.changed, false);
  assert.equal(h.submissions(), 1, 'unconsulted packages and sibling synthetic entries cannot invalidate a queued plan');
}

async function unrelatedFloor(synthetic) {
  const h = fixture(`unrelated-revision-floor-${synthetic}`, { synthetic, churnFloor: true });
  const result = await h.queued();
  assert.equal(result.kind, 'built', JSON.stringify(result));
  assert.equal(result.changed, false, 'a revision-floor advance changed no consulted answer');
  assert.equal(h.submissions(), 1, 'an absent nested manifest is not a subtree watermark');
}

function inputFixture() {
  const fs = launchSession().vfs.as(CRED_KERNEL);
  const dir = 'home/user/app/node_modules/pkg';
  fs.mkdir(dir, { recursive: true });
  fs.writeFile(dir + '/index.js', 'export const x = 1;');
  return { fs, dir };
}

await runScenarios(fileURLToPath(import.meta.url), {
  mainMoves: () => entryMoves('main', false),
  moduleMoves: () => entryMoves('module', false),
  exportsMove: () => entryMoves('exports', false),
  syntheticMainMoves: () => entryMoves('main', true),
  syntheticModuleMoves: () => entryMoves('module', true),
  syntheticExportsMove: () => entryMoves('exports', true),
  unrelatedOrdinaryWrites: () => unrelatedWrites(false),
  unrelatedSyntheticWrites: () => unrelatedWrites(true),
  unrelatedOrdinaryFloor: () => unrelatedFloor(false),
  unrelatedSyntheticFloor: () => unrelatedFloor(true),
  absentAndDirectoryReadsIgnoreFloors() {
    const { fs, dir } = inputFixture();
    const absent = dir + '/package.json';
    const observations = [];
    for (const operation of ['readFile', 'readFileString']) {
      for (const path of [absent, dir, dir + '/index.js']) {
        const inputs = new PrebundleInputs(fs);
        if (path.endsWith('/index.js')) inputs.fs[operation](path);
        else assert.throws(() => inputs.fs[operation](path));
        observations.push({ inputs, path });
      }
    }
    const missingStat = new PrebundleInputs(fs);
    assert.throws(() => missingStat.fs.stat(absent));
    observations.push({ inputs: missingStat, path: absent });
    advanceFloor(fs, absent, 'read-answers');
    for (const { inputs } of observations) assert.equal(inputs.current(), true,
      'a missing or non-file read is guarded by its answer, not the global floor');
    fs.writeFile(absent, '{}');
    for (const { inputs, path } of observations) if (path === absent) assert.equal(inputs.current(), false,
      'a real appearance still invalidates each negative observation');
    fs.writeFile(dir + '/index.js', 'export const x = 2;');
    for (const { inputs, path } of observations) if (path.endsWith('/index.js')) assert.equal(inputs.current(), false,
      'successful reads still notice a same-size file change');
  },
  async entryDisappears() {
    const h = fixture('queued-entry-disappears');
    const result = await h.queued(() => h.fs.writeFile(h.pkg + '/package.json', '{"main":"missing.js"}'));
    assert.equal(result.kind, 'unresolved', JSON.stringify(result));
    assert.equal(h.specs.length, 0);
  },
  async missingScopedInputAppears() {
    const h = fixture('missing-scoped-input', { synthetic: true });
    h.fs.writeFile(h.pkg + '/a.js', 'export { X } from "./late";');
    const result = await h.queued(() => h.fs.writeFile(h.pkg + '/late.js', 'export const X = 1;'));
    assert.equal(result.kind, 'built', JSON.stringify(result));
    assert.ok(h.specs[0].slice.some((item) => item.path.endsWith('/pkg/late.js')),
      'a previously absent resolution candidate is a consulted input');
  },
  sameSizeFileChanges() {
    const { fs, dir } = inputFixture();
    const plan = planSliceForSpecifierWithCap(fs, 'pkg', 'home/user/app/node_modules', 1024 * 1024);
    fs.writeFile(dir + '/index.js', 'export const x = 2;');
    assert.throws(() => materializePrebundleSlice(fs, plan), PrebundlePlanChanged);
  },
  canonicalPlannedNames() {
    const { fs, dir } = inputFixture();
    fs.writeFile(dir + '/日本語.js', 'export const y = 1;');
    const plan = planSliceForSpecifierWithCap(fs, 'pkg', 'home/user/app/node_modules', 1024 * 1024);
    const slice = materializePrebundleSlice(fs, plan);
    assert.deepEqual(slice.map((entry) => entry.path), plan.entries.map((entry) => entry.slicePath));
    assert.ok(slice.every((entry) => entry.path.startsWith('/') && !entry.path.startsWith('//')));
    assert.equal(prebundleSliceBytes(slice), plan.allocationBytes, 'canonical paths and content use the same payload byte sizer');
  },
  equivalentInputNames() {
    const { fs, dir } = inputFixture();
    let lookups = 0;
    const inputs = new PrebundleInputs({ ...fs,
      stat(path) { lookups++; return fs.stat(path); },
      revision(path) { assert.equal(path, undefined, 'only the global clock is consulted'); return fs.revision(); },
    });
    inputs.fs.readFileString(dir + '/index.js');
    inputs.fs.readFileString('/' + dir + '/index.js');
    assert.equal(lookups, 1, 'the VFS-rooted spellings name the same consulted file');
    fs.writeFile(dir + '/index.js', 'export const x = 2;');
    assert.equal(inputs.current(), false);
  },
  missingDependencyAppears() {
    const { fs, dir } = inputFixture();
    fs.writeFile(dir + '/package.json', '{"dependencies":{"late":"*"}}');
    const plan = planSliceForSpecifierWithCap(fs, 'pkg', 'home/user/app/node_modules', 1024 * 1024);
    fs.mkdir('home/user/app/node_modules/late');
    fs.writeFile('home/user/app/node_modules/late/index.js', 'export const late = 1;');
    assert.throws(() => materializePrebundleSlice(fs, plan), PrebundlePlanChanged);
  },
  directoryShapeNotSubtreeClock() {
    const { fs, dir } = inputFixture();
    const inputs = new PrebundleInputs(fs);
    inputs.fs.stat(dir);
    inputs.fs.readdir(dir);
    fs.writeFile(dir + '/index.js', 'export const x = 2;');
    assert.equal(inputs.current(), true, 'unread descendant bytes are not directory metadata');
    fs.writeFile(dir + '/new.js', 'export const y = 1;');
    assert.equal(inputs.current(), false, 'a consulted directory listing changed');
  },
  unavailableDirectoryAppears() {
    const { fs, dir } = inputFixture();
    const inputs = new PrebundleInputs(fs);
    assert.throws(() => inputs.fs.readdir(dir + '/absent'));
    fs.mkdir(dir + '/absent');
    assert.equal(inputs.current(), false);
  },
  recallsRemainWaitable() {
    for (const operation of ['stat', 'access']) {
      const { fs, dir } = inputFixture();
      const recall = new RecallRequired(dir, 'share', dir + '/index.js', async () => {});
      let blocked = false;
      const observed = { ...fs, [operation]: (...args) => {
        if (blocked) throw recall;
        return fs[operation](...args);
      } };
      const inputs = new PrebundleInputs(observed);
      inputs.fs[operation](dir + '/index.js', 4);
      fs.writeFile('home/user/unrelated', 'change the global clock');
      blocked = true;
      assert.throws(() => inputs.current(), (error) => error === recall, 'recall is not downgraded to plan invalidation');
    }
  },
});
