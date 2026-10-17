#!/usr/bin/env bun
// A resident drops uncached serialized sources before its real host opens,
// while cached sources remain usable by the next launch.
import assert from 'node:assert/strict';

import { buildFacetVfsBundleSource, generateLongRunningNodeCode, releaseGeneratedSources, releaseSerializedSources } from '../../packages/worker/src/facets/manager.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FACET_IMAGE_DIR } from '../../packages/fabric/src/process-fabric.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, importModuleSet, moduleMapBundle, storedBootModules, processImageModules } from './lib/module-map-bundle.mjs';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { createProcessFacetCtx, residentRunner } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor } from './lib/one-shot-runner.mjs';
import { CRED, createAuthority, facetSupervisor, residentDataPlan, runScenarios } from './lib/resident-body.mjs';

const rawSetTimeout = setTimeout;
const rawClearTimeout = clearTimeout;
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = rawSetTimeout(() => reject(new Error('resident boot did not reach its boundary')), 5_000);
    })]);
  } finally { rawClearTimeout(timer); }
}

async function launch(cacheRetained) {
  const authority = createAuthority();
  const { rawVfs, host } = authority;
  adoptSessionSupervisor(host, () => {});
  let loaded;
  const run = residentRunner(host.processes);
  const { world, manager, processes } = launchManager(`resident-release-${cacheRetained}`, {
    session: { storage: new Map(), vfs: rawVfs },
    processes: host.processes,
    evaluate(config, info) { loaded.resolve(config); return run(config, info); },
  });
  const fs = rawVfs.as(CRED_KERNEL);
  fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib/index.js' }));
  fs.writeFile('home/user/node_modules/dep/lib/index.js', 'module.exports = 6 * 7;\n');

  let refused = 0;
  if (!cacheRetained) {
    // Refuse admission itself; no state is marked uncached while the cache holds it.
    manager._admitPrefetchCacheEntry = () => { refused++; return false; };
  }
  const builds = new Map();
  const build = manager._buildProcessBundle.bind(manager);
  manager._buildProcessBundle = async (entry, ...args) => {
    const state = await build(entry, ...args);
    builds.set(entry.pid, { state, cursor: structuredClone(state.cursor), serialized: state.bundleSource });
    return state;
  };
  let boundary;
  const open = manager.processHost.open.bind(manager.processHost);
  manager.processHost.open = (params) => {
    try {
      const { state, cursor, serialized } = builds.get(params.pid);
      assert.equal(state.cacheRetained, cacheRetained, 'the real builder followed the admission policy');
      assert.deepEqual(state.bundle, {}, 'raw cells are gone before host.open');
      assert.equal(state.emits, undefined);
      assert.equal(state.esm, undefined);
      assert.deepEqual(state.cursor, cursor, 'release preserves the builder cursor');
      if (cacheRetained) {
        assert.equal(state.bundleSource, serialized, 'the cache keeps its serialized state');
        assert.notEqual(state.generatedSourcesReleased, true);
      } else {
        assert.equal(state.bundleSource, undefined, 'uncached sources are released before host.open');
        assert.equal(state.generatedSourcesReleased, true);
      }
      boundary.resolve();
    } catch (error) {
      boundary.reject(error);
      throw error;
    }
    return open(params);
  };

  let config;
  let previous;
  try {
    for (let i = 0; i < (cacheRetained ? 2 : 1); i++) {
      boundary = Promise.withResolvers();
      loaded = Promise.withResolvers();
      const observed = bounded(boundary.promise);
      const spawned = await manager.spawnNode("console.log(require('dep'));", {
        filename: '/home/user/run.js', cwd: '/home/user', command: 'dep-tui', attachedTty: true,
      });
      assert.ok(spawned.pid > 0);
      await observed;
      config = await bounded(loaded.promise);
      const built = builds.get(spawned.pid);
      if (previous) {
        assert.equal(built.state.cacheHit, true, 'a second launch uses the retained state');
        assert.equal(built.serialized, previous.serialized);
      }
      previous = built;
      assert.deepEqual(await storedBootModules(world, fs), processImageModules(config),
        'the complete map is reconstructed from stored images and shared assets');
    }
    if (!cacheRetained) assert.equal(refused, 1, 'the admission policy really refused this build');
    assert.ok(fs.readdir(FACET_IMAGE_DIR).length > 0);

    // Run the stored map, not a separately generated copy of its program.
    const mod = await importModuleSet(config.modules, 'worker.js');
    const { supervisor, log } = facetSupervisor(authority);
    const proc = new mod.NimbusProcess(createProcessFacetCtx(`released-${cacheRetained}`), { SUPERVISOR: supervisor });
    await bounded(proc.startProcess({
      pid: log.pid, vfsCursor: previous.cursor,
      dataPlan: await residentDataPlan(authority, '/home/user'),
    }));
    assert.equal(log.stderr, '');
    assert.equal(log.stdout.trim(), '42', 'the emitted entry can still require and execute the stored dependency');
  } finally {
    for (const entry of processes.getRunning()) processes.kill(entry.pid);
  }
}

await runScenarios(import.meta.path, {
  async 'total release'() {
    const bundle = { 'home/user/a.js': 'module.exports = 42;\n' };
    const cursor = { epoch: 'e', rev: 7 };
    const state = { bundle, cursor, reachableCount: 1, truncated: false, emits: new Map(), esm: new Map() };
    state.bundleSource = await buildFacetVfsBundleSource(state.bundle);
    releaseSerializedSources(state);
    assert.deepEqual(state.bundle, {});
    assert.equal(state.emits, undefined);
    assert.equal(state.esm, undefined);
    const generated = await generateLongRunningNodeCode('', state, { cred: CRED }, false, nodeFacetSources('/* shims */'));
    assert.deepEqual(moduleMapBundle(generatedModuleSet(generated, 'worker.js')), bundle,
      'serialization preserves the program data');
    releaseGeneratedSources(state);
    assert.equal(state.bundleSource, undefined);
    assert.equal(state.generatedSourcesReleased, true);
    assert.deepEqual(state.cursor, cursor);
    await assert.rejects(() => generateLongRunningNodeCode('', state, { cred: CRED }, false, nodeFacetSources('/* shims */')));
  },
  'uncached launch': () => launch(false),
  'cached launch and reuse': () => launch(true),
});

console.log('resident-launch-releases-module-map: ok');
