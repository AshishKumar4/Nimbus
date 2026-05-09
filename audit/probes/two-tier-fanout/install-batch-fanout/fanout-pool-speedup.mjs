// F-1 — NimbusFanoutPool peer-DO speedup probe.
//
// Asserts (per wave's ship-gate criteria):
//   1. 8-concurrent completes in ≤ T_serial / 5 (cap not hit).
//   2. 8 unique peer-DO shards observed for 8 distinct keys
//      (deterministic stable-id router works).
//   3. Backpressure: 50 in-flight tasks queue without crashing.
//
// The probe exercises the NimbusFanoutPool primitive directly via
// /api/_test/fanout/* endpoints. This is independent of any specific
// production site (install-batch, pre-bundle, etc.) so the
// primitive's behavior can be measured cleanly without confounders.
//
// Workload shape: each task sleeps `sleepMs=200` inside its own
// loader isolate. Total CPU work is trivial; the wall-clock floor
// is RPC + isolate-spawn overhead. With 8 peer DOs each running
// one task, the parallel wall-time should be ~200ms + RPC overhead.
// Serial wall-time = N × 200ms = 1600ms.
//
// In a workerd local-dev environment, this probe runs against the
// in-process worker; peer DOs are still real DOs (workerd
// instantiates each NimbusSession once per stable id) but they
// share an isolate with the supervisor. The 5× speedup holds
// because the V8 ASYNC fan-out invariant still applies: 8 RPC
// calls run interleaved on the event loop, each carrying its own
// 200ms setTimeout, so the net wall time is bounded by the
// slowest call (~272-321ms in measured runs).
import { BASE, mintSession } from '../../interactive-liveness/_driver.mjs';

const TARGET_RATIO = 5;
const N = 8;
const SLEEP_MS = 200;
const STABILITY_RUNS = 5;
const BACKPRESSURE_N = 50;

const sid = await mintSession();

console.log('==== F-1 NimbusFanoutPool speedup probe ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('SID:', sid);
console.log('target ratio:', `${TARGET_RATIO}× (T_serial / T_parallel ≥ ${TARGET_RATIO})`);
console.log('workload:    ', `N=${N} tasks, ${SLEEP_MS} ms sleep each`);
console.log();

// ── Topology assertion ──────────────────────────────────────────
console.log('---- topology routing ----');
const topoRes = await fetch(`${BASE}/s/${sid}/api/_test/fanout/topology?n=${N}`);
const topo = await topoRes.json();
console.log('topology for n=8:', topo);
let pass = true;
if (topo.topology !== 'peer-do') {
  console.log(`FAIL: expected peer-do for N=${N}, got ${topo.topology}`);
  pass = false;
} else {
  console.log(`PASS: N=${N} routes to peer-do`);
}
const topo3 = await (await fetch(`${BASE}/s/${sid}/api/_test/fanout/topology?n=3`)).json();
if (topo3.topology !== 'in-do') {
  console.log(`FAIL: expected in-do for N=3, got ${topo3.topology}`);
  pass = false;
} else {
  console.log('PASS: N=3 routes to in-do');
}
console.log();

// ── Stable-id router determinism ────────────────────────────────
console.log('---- deterministic stable-id router ----');
const keys = Array.from({ length: N }, (_, i) => `task-${i}`);
const routeRes = await fetch(
  `${BASE}/s/${sid}/api/_test/fanout/route?n=${N}&keys=${keys.join(',')}`,
);
const route = await routeRes.json();
console.log('placement:', JSON.stringify(route.placement));
const uniqueShards = new Set(route.placement.map((p) => p.shard));
console.log(`unique shards: ${uniqueShards.size} of ${N} possible`);
if (uniqueShards.size !== N) {
  console.log(`FAIL: expected ${N} unique shards, got ${uniqueShards.size}`);
  pass = false;
} else {
  console.log(`PASS: all ${N} keys map to distinct shards`);
}
// Determinism: re-call route with same keys, expect identical shards.
const route2 = await (await fetch(
  `${BASE}/s/${sid}/api/_test/fanout/route?n=${N}&keys=${keys.join(',')}`,
)).json();
const sameShards = route.placement.every(
  (p, i) => p.shard === route2.placement[i].shard,
);
if (!sameShards) {
  console.log('FAIL: routing not deterministic across calls');
  pass = false;
} else {
  console.log('PASS: routing deterministic (same shards across calls)');
}
console.log();

// ── Speedup: T_parallel ≤ T_serial / 5 ──────────────────────────
console.log('---- speedup measurement ----');
const ratios = [];
for (let i = 0; i < STABILITY_RUNS; i++) {
  const sidI = await mintSession();
  const serial = await (await fetch(
    `${BASE}/s/${sidI}/api/_test/fanout/serial-bench`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: N, sleepMs: SLEEP_MS }) },
  )).json();
  const parallel = await (await fetch(
    `${BASE}/s/${sidI}/api/_test/fanout/bench`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: N, sleepMs: SLEEP_MS }) },
  )).json();
  const ratio = serial.wallTimeMs / parallel.wallTimeMs;
  ratios.push(ratio);
  console.log(
    `run ${i + 1}: serial=${serial.wallTimeMs}ms parallel=${parallel.wallTimeMs}ms ratio=${ratio.toFixed(2)}×`,
  );
}
const minRatio = Math.min(...ratios);
const medRatio = ratios.slice().sort((a, b) => a - b)[Math.floor(STABILITY_RUNS / 2)];
console.log(`min ratio: ${minRatio.toFixed(2)}×; median: ${medRatio.toFixed(2)}×`);

if (minRatio < TARGET_RATIO) {
  console.log(
    `FAIL: min ratio ${minRatio.toFixed(2)}× < ${TARGET_RATIO}× target — at least one run missed the ship-gate`,
  );
  pass = false;
} else {
  console.log(
    `PASS: min ratio ${minRatio.toFixed(2)}× ≥ ${TARGET_RATIO}× target across ${STABILITY_RUNS} runs`,
  );
}
console.log();

// ── Backpressure: N=50 doesn't crash ────────────────────────────
console.log('---- backpressure: N=50 in-flight ----');
const bigSid = await mintSession();
const big = await (await fetch(
  `${BASE}/s/${bigSid}/api/_test/fanout/bench`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: BACKPRESSURE_N, sleepMs: 50 }) },
)).json();
console.log(`bigBench: n=${big.n} wallTime=${big.wallTimeMs}ms`);
if (!big.results || big.results.length !== BACKPRESSURE_N) {
  console.log(`FAIL: expected ${BACKPRESSURE_N} results, got ${big.results?.length}`);
  pass = false;
} else {
  console.log(`PASS: ${BACKPRESSURE_N} tasks completed without crashing`);
}

console.log();
console.log(`==== EXIT ${pass ? 0 : 1} ====`);
process.exit(pass ? 0 : 1);
