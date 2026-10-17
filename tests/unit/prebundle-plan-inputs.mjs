#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { PrebundlePool } from '../../packages/worker/src/facets/prebundle-pool.ts';
import { buildPrebundle, storedPrebundle } from '../../packages/worker/src/npm/browser-prebundle.ts';
import { NpmCache } from '../../packages/worker/src/npm/cache.ts';
import { launchSession } from './lib/facet-launch-harness.mjs';
import { namedFacetPlatform } from './lib/named-facet-platform.mjs';
import { runScenarios } from './lib/resident-body.mjs';

function fixture(name, { field = 'main', synthetic = false, unrelated = false } = {}) {
  const session = launchSession();
  const fs = session.vfs.as(CRED_KERNEL);
  const root = 'home/user/app';
  const pkg = root + '/node_modules/pkg';
  const manifest = (entry) => JSON.stringify({ name: 'pkg', type: 'module', [field]: field === 'exports' ? './' + entry : entry });
  for (const dir of ['pkg', 'blocker', 'other', '.nimbus-synthetic']) fs.mkdir(root + '/node_modules/' + dir, { recursive: true });
  fs.writeFile(pkg + '/package.json', manifest('index-a.js'));
  fs.writeFile(pkg + '/index-a.js', synthetic ? 'export { X } from "./a.js";' : 'export const X = "A";');
  fs.writeFile(pkg + '/index-b.js', synthetic ? 'export { X } from "./b.js";' : 'export const X = "B";');
  fs.writeFile(pkg + '/a.js', 'export const X = "A";');
  fs.writeFile(pkg + '/b.js', 'export const X = "B";');
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
        submitted.resolve();
      }
      return pending;
    } };
  } };
  const context = { vfs: fs, root, cache: new NpmCache(session.disk.sql), pool, parse: async (_path, source) => source,
    esbuild: new EsbuildService(undefined, {}), serviceFallback: false, running: true };
  const barrel = synthetic ? { pkgName: 'pkg', fileCount: 1000, names: new Set(['X']), inputHash: 'x' } : null;
  return { fs, pkg, context, barrel, specs, submissions: () => submissions,
    move: () => fs.writeFile(pkg + '/package.json', manifest('index-b.js')),
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

await runScenarios(fileURLToPath(import.meta.url), {
  mainMoves: () => entryMoves('main', false),
  moduleMoves: () => entryMoves('module', false),
  exportsMove: () => entryMoves('exports', false),
  syntheticMainMoves: () => entryMoves('main', true),
  syntheticModuleMoves: () => entryMoves('module', true),
  syntheticExportsMove: () => entryMoves('exports', true),
  unrelatedOrdinaryWrites: () => unrelatedWrites(false),
  unrelatedSyntheticWrites: () => unrelatedWrites(true),
  async missingScopedInputAppears() {
    const h = fixture('missing-scoped-input', { synthetic: true });
    h.fs.writeFile(h.pkg + '/a.js', 'export { X } from "./late";');
    const result = await h.queued(() => h.fs.writeFile(h.pkg + '/late.js', 'export const X = 1;'));
    assert.equal(result.kind, 'built', JSON.stringify(result));
    assert.ok(h.specs[0].slice.some((item) => item.path.endsWith('/pkg/late.js')),
      'a previously absent resolution candidate is a consulted input');
  },
});
