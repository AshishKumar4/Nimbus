#!/usr/bin/env bun
// Parked maps retain only their owned strings, and partial gathers bounce
// before reading a file that does not fit their share of the isolate budget.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { beginHelperFetch, beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT, loaderLedgerStats, withLaunchAdmission } from '../../packages/fabric/src/budgets.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { ModuleSource } from '../../packages/platform/src/module-source.ts';
import { fetchNodeFacetSources } from '../../packages/worker/src/runtime/node-shims-artifact.ts';
import { acquireSupervisorAllocation, acquireSupervisorRunningAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { launchManager } from './lib/facet-launch-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { createAuthority, runScenarios, until } from './lib/resident-body.mjs';

function session(authority, name) {
  const ctx = createFacetCtx(createFacetWorld(() => ({})), name);
  const manager = oneShotManager(name, { host: authority.host, rawVfs: authority.rawVfs, loader: runnerLoader(name), ctx });
  return { ctx, manager };
}
const occupy = (ctx) => Array.from({ length: DO_DYNAMIC_WORKER_LIMIT }, (_, i) => beginLoaderFetch(ctx, `busy-${i}`));
const drained = () => {
  const budget = readSupervisorAllocationBudget();
  assert.equal(budget.current, 0, JSON.stringify(budget));
  assert.equal(budget.queued, 0, JSON.stringify(budget));
  assert.ok(budget.peak <= budget.capacity, JSON.stringify(budget));
};
const ran = (result, stdout) => {
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, stdout);
};

async function runningWorkReclaims(brokered, race) {
  const authority = createAuthority();
  adoptSessionSupervisor(authority.host, () => {});
  const { manager, ctx } = session(authority, `reclaimed-${brokered}`);
  const cwd = '/home/user/reclaimed';
  authority.kfs.mkdir(cwd);
  authority.kfs.writeFile(`${cwd}/cell.js`, `module.exports = 7;\n// ${'x'.repeat(256 * 1024)}\n`);
  const code = 'process.stdout.write(String(require("./cell.js")))';
  const options = { cwd, filename: `${cwd}/run.js`, captureOutput: true };
  const holds = [];
  const other = createFacetCtx(createFacetWorld(() => ({})), `running-${brokered}`);
  const running = beginLoaderFetch(other, 'running-facet');
  try {
    let waiting;
    if (brokered) {
      const entry = authority.host.processes.spawn('node run.js', [], cwd);
      waiting = withLaunchAdmission(ctx, { pid: entry.pid }, undefined, () => {
        const done = manager.exec(code, { ...options, skipSpawn: true, callerPid: entry.pid });
        holds.push(...occupy(ctx));
        return done;
      });
    } else {
      holds.push(...occupy(ctx));
      waiting = manager.exec(code, options);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await until(() => manager.launchState().launches[0]?.stage === 'admission' && loaderLedgerStats(ctx).waiting === 1,
        'the generated map is parked on its own session ledger', 20_000);
      assert.ok(readSupervisorAllocationBudget().current > 0, 'the parked map retains its share');
      if (race === 'grant') holds.shift()();
      let timer;
      const acquiring = acquireSupervisorRunningAllocation(readSupervisorAllocationBudget().capacity);
      if (race === 'kill') manager.kill(manager.launchState().launches[0].pid);
      const lease = await Promise.race([
        acquiring,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('running work waited on a parked launch')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (race === 'kill') {
        lease.release();
        const result = await waiting;
        assert.equal(result.exitCode, 130, result.stderr);
        assert.equal(loaderLedgerStats(ctx).waiting, 0, 'a kill during reclaim leaves no worker wait');
        return;
      }
      try {
        await until(() => manager.launchState().launches[0]?.stage === 'prepare' && loaderLedgerStats(ctx).waiting === 0,
          'the reclaimed launch leaves its worker wait and prepares again');
        assert.equal(readSupervisorAllocationBudget().current, lease.bytes, 'only running work holds credit after reclaim');
        assert.deepEqual(loaderLedgerStats(other).inFlightWorkers, ['running-facet'], 'the running facet kept its worker');
      } finally {
        lease.release();
      }
      if (race === 'grant') {
        ran(await waiting, '7');
        assert.equal(loaderLedgerStats(ctx).waiting, 0, 'the grant/reclaim race leaves no duplicate readmission');
        return;
      }
    }
    await until(() => manager.launchState().launches[0]?.stage === 'admission' && loaderLedgerStats(ctx).waiting === 1,
      'the map is generated and parked again', 20_000);
    holds.shift()();
    ran(await waiting, '7');
  } finally {
    for (const release of holds) release();
    running();
  }
  drained();
}

await runScenarios(fileURLToPath(import.meta.url), {
  async parkedMapOwnership() {
    const shared = await fetchNodeFacetSources({ ASSETS: stagedAssets });
    const sharedTexts = new Set(Object.values(shared.immutable).map((source) => source.text));
    const ownBytes = (text) => text.length * (/[^\u0000-\u00ff]/.test(text) ? 2 : 1);
    const sourceText = Object.getOwnPropertyDescriptor(ModuleSource.prototype, 'text');
    const generated = [];
    let early = 0;
    let owned = 0;
    const h = launchManager('parked-map-ownership', { env: { LOADER: {
      load(config) {
        const main = generated.shift();
        assert.ok(main, 'the main source is materialized for its loader handoff');
        for (const part of main.parts) if (typeof part === 'string') owned += ownBytes(part);
        for (const [name, member] of Object.entries(config.modules)) {
          if (name === 'runner.js' || typeof member === 'string') continue;
          const text = member.cjs ?? member.js;
          if (typeof text === 'string' && !sharedTexts.has(text)) owned += ownBytes(text);
        }
        return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) };
      },
      get() { throw new Error('one-shots use the unkeyed loader'); },
    } } });
    Object.defineProperty(ModuleSource.prototype, 'text', {
      configurable: true,
      get() {
        if (!h.manager.launchState().launches.some(({ stage }) => stage === 'load')) early++;
        generated.push(this);
        return sourceText.get.call(this);
      },
    });
    const holds = occupy(h.ctx);
    try {
      const launches = [];
      for (let i = 0; i < 3; i++) {
        launches.push(h.manager.exec('2 + 2', { cwd: '/home/user', captureOutput: true }));
        await until(() => h.manager.launchState().launches.filter(({ stage }) => stage === 'admission').length === i + 1,
          'each map is generated and parked');
      }
      const retained = readSupervisorAllocationBudget().current;
      assert.equal(early, 0, 'parking never flattens immutable runtime sources into per-launch strings');
      holds.shift()();
      for (const result of await Promise.all(launches)) ran(result, '');
      assert.equal(retained, owned, 'the parked maps hold exactly the sum of their owned strings, not shared runtime text');
    } finally {
      Object.defineProperty(ModuleSource.prototype, 'text', sourceText);
      for (const release of holds) release();
    }
    drained();
  },

  async ownedWasmMember() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const { manager, ctx } = session(authority, 'owned-wasm-member');
    const cwd = '/home/user/owned-wasm';
    authority.kfs.mkdir(cwd);
    const bytes = new Uint8Array(4 * 1024 * 1024);
    bytes.set([0, 97, 115, 109, 1, 0, 0, 0]);
    authority.kfs.writeFile(`${cwd}/image.wasm`, bytes);
    authority.kfs.writeFile(`${cwd}/cell.js`, 'require("fs").readFileSync(require("path").join(__dirname, "image.wasm")); module.exports = "wasm";');
    const holds = occupy(ctx);
    const waiting = manager.exec('process.stdout.write(require("./cell.js"))', {
      cwd, dirname: cwd, filename: `${cwd}/run.js`, captureOutput: true,
    });
    try {
      await until(() => manager.launchState().launches[0]?.stage === 'admission', 'the map with its wasm member parks', 20_000);
      const budget = readSupervisorAllocationBudget();
      assert.ok(budget.current >= bytes.byteLength, `the owned wasm is covered beside the tiny closure (${JSON.stringify(budget)})`);
      holds.shift()();
      ran(await waiting, 'wasm');
    } finally {
      for (const release of holds) release();
    }
    drained();
  },

  runningWorkReclaims: () => runningWorkReclaims(false),
  brokeredReclaims: () => runningWorkReclaims(true),
  workerGrantRacesReclaim: () => runningWorkReclaims(false, 'grant'),
  killDuringReclaim: () => runningWorkReclaims(false, 'kill'),

  async runningRequestBeforeParking() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const { manager, ctx } = session(authority, 'running-before-parking');
    const cwd = '/home/user/before-parking';
    authority.kfs.mkdir(cwd);
    authority.kfs.writeFile(`${cwd}/cell.js`, `module.exports = 7;\n// ${'x'.repeat(256 * 1024)}\n`);
    const { oxcTransforms } = await import('./lib/oxc-engine.mjs');
    const native = new EsbuildService(undefined, oxcTransforms);
    const entered = Promise.withResolvers();
    const proceed = Promise.withResolvers();
    manager.setEsbuildService(new EsbuildService(undefined, {
      transformHost: async (requests) => {
        entered.resolve();
        await proceed.promise;
        return native.transformMany(requests);
      },
    }));
    const holds = occupy(ctx);
    const waiting = manager.exec('require("./cell.js"); import("node:path").then(path => process.stdout.write(path.default.basename("/home/user/entry")))', {
      cwd, captureOutput: true,
    });
    try {
      await entered.promise;
      let timer;
      const running = Promise.race([
        acquireSupervisorRunningAllocation(readSupervisorAllocationBudget().capacity),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('running work was not woken by a map becoming reclaimable')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      await until(() => readSupervisorAllocationBudget().queued === 1, 'running work queues while the map is still being generated');
      proceed.resolve();
      const lease = await running;
      try {
        await until(() => manager.launchState().launches[0]?.stage === 'prepare' && loaderLedgerStats(ctx).waiting === 0,
          'the newly reclaimable map is dropped for the already-waiting running request');
      } finally {
        lease.release();
      }
      await until(() => manager.launchState().launches[0]?.stage === 'admission' && loaderLedgerStats(ctx).waiting === 1,
        'the reclaimed launch prepares its map again');
      holds.shift()();
      ran(await waiting, 'entry');
    } finally {
      proceed.resolve();
      for (const release of holds) release();
    }
    drained();
  },

  async entryHelperOwner() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const { manager, ctx } = session(authority, 'entry-helper-owner');
    const { oxcTransforms } = await import('./lib/oxc-engine.mjs');
    const native = new EsbuildService(undefined, oxcTransforms);
    const owners = [];
    manager.setEsbuildService(new EsbuildService(undefined, {
      transformHost: async (requests) => {
        const end = await beginHelperFetch(ctx, 'entry-transform');
        try {
          owners.push(loaderLedgerStats(ctx).holders['entry-transform']);
          return await native.transformMany(requests);
        } finally {
          end();
        }
      },
    }));
    const result = await manager.exec('import("node:path").then(path => process.stdout.write(path.default.basename("/home/user/entry")))', {
      cwd: '/home/user', captureOutput: true,
    });
    ran(result, 'entry');
    assert.ok(owners.length > 0, 'the evaluated entry used its transform helper');
    assert.ok(owners.every((pids) => pids.length === 1 && pids[0] > 0), 'every generation helper is owned by the launch process');
    drained();
  },

  async parkedBurst() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const busy = session(authority, 'retained-burst');
    const other = session(authority, 'retained-other');
    const holds = occupy(busy.ctx);
    const launches = [];
    const capacity = readSupervisorAllocationBudget().capacity;
    try {
      for (let i = 0; capacity - readSupervisorAllocationBudget().current >= 12_288; i++) {
        assert.ok(i < 24, 'the retained maps fill the useful room');
        const free = capacity - readSupervisorAllocationBudget().current;
        const cwd = `/home/user/burst-${i}`;
        authority.kfs.mkdir(cwd);
        authority.kfs.writeFile(`${cwd}/cell.js`, `module.exports = 7;\n// ${'x'.repeat(Math.max(4096, Math.floor(free / 4) - 1024))}\n`);
        launches.push(busy.manager.exec('process.stdout.write(String(require("./cell.js")))', {
          cwd, filename: `${cwd}/run.js`, captureOutput: true,
        }));
        await until(() => busy.manager.launchState().launches.filter(({ stage }) => stage === 'admission').length === i + 1,
          `parked map ${i + 1}: ${JSON.stringify(readSupervisorAllocationBudget())}`, 20_000);
        assert.equal(readSupervisorAllocationBudget().queued, 0, 'the burst parks, rather than queueing builds');
      }
      assert.ok(launches.length >= 3, 'several maps, not one exclusive lease, fill the budget');
      let finished = false;
      const waiting = other.manager.exec('process.stdout.write("other")', { cwd: '/home/user/other', captureOutput: true })
        .then((result) => { finished = true; return result; });
      await until(() => readSupervisorAllocationBudget().queued === 1, 'a new unmeasured build queues behind retained maps');
      assert.equal(finished, false, 'a full isolate starts no new build');
      holds.shift()();
      ran(await waiting, 'other');
      for (const result of await Promise.all(launches)) ran(result, '7');
    } finally {
      for (const release of holds) release();
    }
    drained();
  },

  async boundedBounce() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const { manager } = session(authority, 'bounded-bounce');
    const cwd = '/home/user/bounce';
    authority.kfs.mkdir(cwd);
    authority.kfs.writeFile(`${cwd}/first.js`, `module.exports = 3;\n// ${'x'.repeat(10 * 1024)}\n`);
    authority.kfs.writeFile(`${cwd}/large.js`, `module.exports = 4;\n// ${'x'.repeat(128 * 1024)}\n`);
    const reads = [];
    const files = processFiles(authority.rawVfs);
    manager.setVfs(authority.rawVfs, new Proxy(files, {
      get(target, key) {
        if (key === 'bind') return (...args) => {
          const view = target.bind(...args);
          return new Proxy(view, {
            get(bound, member) {
              if (member === 'readFile') return (path) => {
                if (path.endsWith('/first.js') || path.endsWith('/large.js') || path.endsWith('/manifest/package.json')) reads.push(path);
                return bound.readFile(path);
              };
              const value = Reflect.get(bound, member, bound);
              return typeof value === 'function' ? value.bind(bound) : value;
            },
          });
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }));
    const budget = readSupervisorAllocationBudget();
    const held = await acquireSupervisorAllocation(budget.capacity - 192 * 1024);
    const waiting = manager.exec('process.stdout.write(String(require("./first.js") + require("./large.js")))', {
      cwd, filename: `${cwd}/run.js`, captureOutput: true,
    });
    try {
      await until(() => readSupervisorAllocationBudget().queued === 1, 'the bounded walk bounced to a full-capacity FIFO ask');
      assert.equal(reads.filter((path) => path.endsWith('/first.js')).length, 1, 'the first bounded walk read the small file once');
      assert.equal(reads.filter((path) => path.endsWith('/large.js')).length, 0, 'the crossing file was refused from its stat before reading it');
      assert.equal(readSupervisorAllocationBudget().current, budget.capacity - 192 * 1024, 'the partial gather gave all its credit back before queueing');
    } finally {
      held.release();
    }
    ran(await waiting, '7');
    assert.ok(reads.some((path) => path.endsWith('/large.js')), 'the whole-budget retry read the crossing file');
    drained();

    authority.kfs.mkdir(`${cwd}/node_modules/manifest`, { recursive: true });
    authority.kfs.writeFile(`${cwd}/node_modules/manifest/package.json`, JSON.stringify({ name: 'manifest', main: 'index.js', padding: 'x'.repeat(128 * 1024) }));
    authority.kfs.writeFile(`${cwd}/node_modules/manifest/index.js`, 'module.exports = 7;');
    const metadataHold = await acquireSupervisorAllocation(budget.capacity - 192 * 1024);
    const metadata = manager.exec('process.stdout.write(String(require("manifest")))', {
      cwd, filename: `${cwd}/manifest-run.js`, captureOutput: true,
    });
    try {
      await until(() => readSupervisorAllocationBudget().queued === 1, 'eager metadata crosses the final raw-byte bound and bounces');
      assert.ok(reads.some((path) => path.endsWith('/manifest/package.json')), 'the existing eager-manifest walk reads metadata before its final check');
      assert.equal(readSupervisorAllocationBudget().current, budget.capacity - 192 * 1024, 'the metadata bounce returns its partial share');
    } finally {
      metadataHold.release();
    }
    ran(await metadata, '7');
    drained();
  },

  async stringWidth() {
    const authority = createAuthority();
    adoptSessionSupervisor(authority.host, () => {});
    const { ctx, manager } = session(authority, 'retained-width');
    const cwd = '/home/user/width';
    authority.kfs.mkdir(cwd);
    const measure = async (character, units) => {
      authority.kfs.writeFile(`${cwd}/cell.js`, `module.exports = 7;\n// ${character.repeat(units)}\n`);
      const holds = occupy(ctx);
      const waiting = manager.exec('process.stdout.write(String(require("./cell.js")))', { cwd, filename: `${cwd}/run.js`, captureOutput: true });
      try {
        await until(() => manager.launchState().launches[0]?.stage === 'admission', 'the map is generated and parked', 20_000);
        const retained = readSupervisorAllocationBudget().current;
        holds.shift()();
        ran(await waiting, '7');
        return retained;
      } finally {
        for (const release of holds) release();
      }
    };
    const small = 128 * 1024;
    const large = 256 * 1024;
    const latinSmall = await measure('x', small);
    const latinLarge = await measure('x', large);
    const latinExtended = await measure('é', large);
    const wideSmall = await measure('Ā', small);
    const wideLarge = await measure('Ā', large);
    assert.equal(latinExtended, latinLarge, 'Latin1 uses one byte per unit, not its UTF-8 width');
    assert.equal(wideLarge - wideSmall, 2 * (latinLarge - latinSmall), 'non-Latin1 map strings are held at two bytes per unit');
    drained();
  },
});
console.log('launch-credit-retention: parked maps bound the burst, a partial gather bounces once, and V8 string width is retained');
