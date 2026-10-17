#!/usr/bin/env bun
// Parked maps retain only their owned strings, and partial gathers bounce
// before reading a file that does not fit their share of the isolate budget.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { beginHelperFetch, beginLoaderFetch, DO_DYNAMIC_WORKER_LIMIT, loaderLedgerStats } from '../../packages/fabric/src/budgets.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { acquireSupervisorAllocation, readSupervisorAllocationBudget } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';
import { processFiles } from './lib/process-bridge.mjs';
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

await runScenarios(fileURLToPath(import.meta.url), {
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
