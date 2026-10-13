#!/usr/bin/env bun
// @serial
// Kinu #29: a launch's cache-miss build holds its admission (the build's
// share of the supervisor's admitted transient budget) while it serializes
// its cells, not only while it gathers them, so concurrent builds queue for
// room through both. Through the real FacetManager.exec path, observing the
// production cell serializer without replacing its work or the bytes it
// makes:
//   - each build serializes under its own admission, and three distinct
//     launches at once peak, live (after a collection), at one launch's
//     plus the admitted budget; the peak in use between collections is
//     reported, not gated;
//   - launches of one key at once build once; a build queued across a write
//     builds the new generation; a failure gives its admission back;
//   - three ~17 MiB builds sharing the pool all finish, peaking, live, at
//     one launch's plus the admitted budget, and one that fails or is
//     killed while it holds its admission stops none of the others;
//   - two launches of one ~17 MiB program at once (past the cache's entry
//     bound) build once.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { heapStats } from 'bun:jsc';
import { readSupervisorAllocationBudget, acquireSupervisorAllocation, registerAllocObserver } from '../../packages/platform/src/heavy-alloc-coord.ts';
import { VFS_BUNDLE_MAX_BYTES } from '../../packages/core/src/constants.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }), NimbusLoadedEntrypoint: () => ({
  async startProcess() { return { ok: true }; }, async handleHttpRequest() { return new Response('ok'); },
}) });

const cellsPath = new URL('../../packages/core/src/_shared/commonjs-cell.ts', import.meta.url).pathname;
const cells = await import(cellsPath);
const legacyWrap = cells.wrapCommonJsCell;
const reservations = [];
// The heap's bytes in use: its objects, and the buffers of strings and arrays JSC keeps beside them (extraMemorySize).
const used = () => { const stats = heapStats(); return stats.heapSize + stats.extraMemorySize; };
// What is live: the bytes in use after a full collection. The gate is on these, as a memory limit is
// (V8 in workerd, and JSC under pressure, collect before declaring it out of memory); `peak`, sampled
// between collections, also counts what the next collection frees, and is reported, not gated.
const live = () => { Bun.gc(true); return used(); };
let peak = 0;
let livePeak = 0;
let failSerialization = false;
// What a ~17 MiB build does as it starts serializing its cell (the three-caller
// cases below): fail, or be killed, while it holds its admission. And how many
// times each was serialized.
const onBigCell = new Map();
const bigSerialized = new Map();
mock.module(cellsPath, () => ({ ...cells,
  wrapCommonJsCell(...args) {
    const big = /PREFETCH_BIG_EVIDENCE ([\w-]+)/.exec(args[0].slice(0, 64))?.[1];
    if (big !== undefined) {
      bigSerialized.set(big, (bigSerialized.get(big) ?? 0) + 1);
      peak = Math.max(peak, used());
      livePeak = Math.max(livePeak, live());
      onBigCell.get(big)?.();
    }
    if (args[0].includes('PREFETCH_LEASE_EVIDENCE')) {
      reservations.push(readSupervisorAllocationBudget().current);
      peak = Math.max(peak, used());
      livePeak = Math.max(livePeak, live());
      if (failSerialization) throw new Error('injected serializer failure');
    }
    return legacyWrap(...args);
  },
}));
const { launchManager } = await import('./lib/facet-launch-harness.mjs');
const execLoader = {
  load() { return { getEntrypoint: () => ({ async run() { return Response.json({ exitCode: 0, stdout: '', stderr: '' }); } }) }; },
  get() { throw new Error('one-shot fixture uses load, not named resident get'); },
};
const env = { LOADER: execLoader };
const { manager, vfs, processes } = launchManager('prefetch-serialization-credit', { env });
// The session's disposable read cache gives way while transient payloads are
// admitted, as the session wires it (worker session/session-filesystem.ts):
// the bound is on what a launch holds, not on what the cache keeps.
registerAllocObserver({ onAcquire: () => vfs.shrinkForInstall(), onRelease: () => vfs.restoreAfterInstall() });
const fs = vfs.as(CRED_KERNEL);
for (let i = 0; i < 4; i++) {
  fs.mkdir(`home/user/tree${i}`, { recursive: true, mode: 0o755 });
  fs.writeFile(`home/user/tree${i}/cell.js`, `// PREFETCH_LEASE_EVIDENCE\nmodule.exports = "${'x'.repeat(10 * 1024 * 1024)}";\n`, { mode: 0o644 });
}
/** `launch`, its live bytes read as it ends. */
const ended = (launch) => launch.then((result) => { livePeak = Math.max(livePeak, live()); return result; },
  (error) => { livePeak = Math.max(livePeak, live()); throw error; });
const launchTree = (i) => ended(manager.exec("require('./cell.js')", { filename: `/home/user/tree${i}/run.js`, cwd: `/home/user/tree${i}`, captureOutput: true }));
/**
 * The live peak over the settled base while `run` runs (read as each build
 * starts serializing and as each launch ends), and the peak in use sampled
 * between collections (`churn`).
 */
const peakOver = async (run) => {
  const base = live();
  peak = base;
  livePeak = base;
  const result = await run();
  livePeak = Math.max(livePeak, live());
  return { result, over: livePeak - base, churn: Math.max(peak, used()) - base };
};
const sampled = setInterval(() => { peak = Math.max(peak, used()); }, 1);
const started = performance.now();
try {
  // One build alone, for its bytes.
  const single = await peakOver(() => launchTree(3));
  assert.equal(single.result.exitCode, 0, single.result.stderr);
  reservations.length = 0;
  const together = await peakOver(() => Promise.all([0, 1, 2].map(launchTree)));
  const results = together.result;
  const capacity = readSupervisorAllocationBudget().capacity;
  console.log('PREFETCH_SERIALIZATION ' + JSON.stringify({ callers: 3, elapsedMs: performance.now() - started,
    singlePeakOverBase: single.over, peakOverBase: together.over, singleChurn: single.churn, churn: together.churn, capacity, reservations, results: results.map(({ exitCode, stderr }) => ({ exitCode, stderr })) }));
  assert.ok(results.every(result => result.exitCode === 0), JSON.stringify(results));
  assert.equal(reservations.length, 3, 'every distinct launch serialized its large cell');
  assert.ok(reservations.every(bytes => bytes >= VFS_BUNDLE_MAX_BYTES && bytes <= capacity),
    `each build serializes under its own admission (${reservations.join(', ')} held; one build's is ${VFS_BUNDLE_MAX_BYTES})`);
  assert.ok(together.over <= single.over + capacity,
    `three launches at once peak, live, at one launch's bytes plus the admitted budget (${together.over} > ${single.over} + ${capacity})`);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'completed builds release their allocation');
  fs.mkdir('home/user/shared', { recursive: true, mode: 0o755 });
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=1;', { mode: 0o644 });
  const options = { filename: '/home/user/shared/run.js', cwd: '/home/user/shared', captureOutput: true };
  const count = reservations.length;
  const identical = await Promise.all(Array.from({ length: 3 }, () => manager.exec("require('./cell.js')", options)));
  assert.ok(identical.every(result => result.exitCode === 0));
  assert.equal(reservations.length - count, 1, 'same-key waiters use the published cache after admission instead of gathering again');
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=2;', { mode: 0o644 });
  failSerialization = true;
  await assert.rejects(manager.exec("require('./cell.js')", options), /injected serializer failure/);
  assert.equal(readSupervisorAllocationBudget().current, 0, 'a serializer failure cannot leak its lease');
  failSerialization = false;
  assert.equal((await manager.exec("require('./cell.js')", options)).exitCode, 0, 'the next launch can be admitted after failure');
  // A queued build must re-read the generation after admission; an old
  // cache hit observed before the wait is not authority for the new tree.
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=3;');
  const hold = await acquireSupervisorAllocation(readSupervisorAllocationBudget().capacity);
  const beforeWait = reservations.length;
  const queued = manager.exec("require('./cell.js')", options);
  for (let i = 0; readSupervisorAllocationBudget().queued === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(readSupervisorAllocationBudget().queued > 0, 'the real manager build is waiting for allocation');
  fs.writeFile('home/user/shared/cell.js', '// PREFETCH_LEASE_EVIDENCE\nmodule.exports=4;');
  hold.release();
  assert.equal((await queued).exitCode, 0);
  assert.equal(reservations.length - beforeWait, 1);
  const afterNewGeneration = reservations.length;
  assert.equal((await manager.exec("require('./cell.js')", options)).exitCode, 0);
  assert.equal(reservations.length, afterNewGeneration, 'the queued build published the newly read generation, so its next launch is a cache hit');
  assert.equal(readSupervisorAllocationBudget().current, 0);

  // Three callers whose closures are ~17 MiB each share the 40 MiB pool
  // (SingleNightingale's recheck of f7cb5aab2): two hold their admissions and
  // the third queues for its own. A build that asked the pool again while
  // holding its cells waited behind the third, which waited for it: all
  // three deadlocked. A build asks once.
  const BIG = 17 * 1024 * 1024;
  const bigTree = (name) => {
    fs.mkdir(`home/user/big-${name}`, { recursive: true, mode: 0o755 });
    fs.writeFile(`home/user/big-${name}/cell.js`, `// PREFETCH_BIG_EVIDENCE ${name}\nmodule.exports = "${'z'.repeat(BIG)}".length;\n`, { mode: 0o644 });
    return { filename: `/home/user/big-${name}/run.js`, cwd: `/home/user/big-${name}`, captureOutput: true };
  };
  const settleWithin = (runs, ms) => Promise.race([
    Promise.allSettled(runs),
    new Promise((resolve) => setTimeout(() => resolve('deadlocked'), ms)),
  ]);
  const drained = () => {
    const budget = readSupervisorAllocationBudget();
    assert.equal(budget.current, 0, `every admission was given back (${JSON.stringify(budget)})`);
    assert.equal(budget.queued, 0, `nothing is left queued (${JSON.stringify(budget)})`);
  };
  const three = (names) => names.map((name) => ended(manager.exec("require('./cell.js')", bigTree(name))));
  let peakHeld = 0;
  const watchHeld = setInterval(() => { peakHeld = Math.max(peakHeld, readSupervisorAllocationBudget().current); }, 1);
  try {
    // One ~17 MiB build alone, for its bytes; then three at once peak at one build's plus the admitted budget.
    const alone = await peakOver(() => ended(manager.exec("require('./cell.js')", bigTree('alone'))));
    assert.equal(alone.result.exitCode, 0, alone.result.stderr);
    const bigThree = await peakOver(() => settleWithin(three(['a', 'b', 'c']), 120_000));
    const settled = bigThree.result;
    assert.notEqual(settled, 'deadlocked', 'three ~17 MiB builds sharing the pool all finish');
    assert.deepEqual(settled.map((r) => r.status === 'fulfilled' ? r.value.exitCode : String(r.reason)), [0, 0, 0]);
    assert.ok(peakHeld <= readSupervisorAllocationBudget().capacity, `the pool's ceiling held (${peakHeld})`);
    const capacity = readSupervisorAllocationBudget().capacity;
    console.log('PREFETCH_SERIALIZATION_BIG ' + JSON.stringify({ singlePeakOverBase: alone.over, peakOverBase: bigThree.over, singleChurn: alone.churn, churn: bigThree.churn, capacity }));
    assert.ok(alone.over > BIG, `one ~17 MiB build is measured (${alone.over} bytes over its base)`);
    assert.ok(bigThree.over <= alone.over + capacity,
      `three ~17 MiB launches at once peak, live, at one launch's bytes plus the admitted budget (${bigThree.over} > ${alone.over} + ${capacity})`);
    drained();

    // Two launches of one ~17 MiB program at once: past the cache's entry
    // bound, nothing is published for the second to take, so it takes the
    // first's own result (the filesystem still at the revision it read): one
    // build, both run.
    const same = bigTree('same');
    const pair = await settleWithin([manager.exec("require('./cell.js')", same), manager.exec("require('./cell.js')", same)], 120_000);
    assert.notEqual(pair, 'deadlocked', 'two same-key ~17 MiB launches finish');
    assert.deepEqual(pair.map((r) => r.status === 'fulfilled' ? r.value.exitCode : String(r.reason)), [0, 0]);
    assert.equal(bigSerialized.get('same'), 1, `two same-key ~17 MiB launches at once build once (${bigSerialized.get('same')} builds)`);
    drained();
    // A write between them: the next launch builds the new generation.
    fs.writeFile('home/user/big-same/cell.js', `// PREFETCH_BIG_EVIDENCE same\nmodule.exports = "${'y'.repeat(BIG)}".length;\n`, { mode: 0o644 });
    assert.equal((await manager.exec("require('./cell.js')", same)).exitCode, 0);
    assert.equal(bigSerialized.get('same'), 2, 'a launch after a write builds the new generation');
    drained();

    // A build that fails while it holds its admission gives it back, and the
    // build queued behind it is admitted and finishes.
    onBigCell.set('fail-b', () => { throw new Error('injected ~17 MiB serializer failure'); });
    const failed = await settleWithin(three(['fail-a', 'fail-b', 'fail-c']), 120_000);
    onBigCell.delete('fail-b');
    assert.notEqual(failed, 'deadlocked', 'a failure among three ~17 MiB builds stops none of the others');
    assert.equal(failed[1].status, 'rejected');
    assert.match(String(failed[1].reason), /injected ~17 MiB serializer failure/);
    assert.deepEqual([failed[0], failed[2]].map((r) => r.status === 'fulfilled' ? r.value.exitCode : String(r.reason)), [0, 0]);
    drained();

    // A launch killed while it holds its admission (mid-serialization) gives
    // it back: the others finish and the pool drains.
    onBigCell.set('kill-a', () => {
      onBigCell.delete('kill-a');
      const victim = processes.getRunning().find((entry) => entry.cwd === '/home/user/big-kill-a');
      assert.ok(victim, 'the launch being serialized is running');
      manager.kill(victim.pid);
    });
    const killed = await settleWithin(three(['kill-a', 'kill-b', 'kill-c']), 120_000);
    onBigCell.delete('kill-a');
    assert.notEqual(killed, 'deadlocked', 'a launch killed mid-build stops none of the others');
    assert.deepEqual([killed[1], killed[2]].map((r) => r.status === 'fulfilled' ? r.value.exitCode : String(r.reason)), [0, 0]);
    assert.ok(killed[0].status === 'rejected' || killed[0].value.exitCode !== 0, `the killed launch did not run as if never killed (${JSON.stringify(killed[0].value ?? String(killed[0].reason))})`);
    drained();
  } finally { clearInterval(watchHeld); }
} finally { clearInterval(sampled); }
