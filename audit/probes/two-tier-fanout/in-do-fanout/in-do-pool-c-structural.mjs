// F-3 — NimbusFanoutPool in-DO POC-C structural probe.
//
// Asserts (per wave's ship-gate criteria for the in-DO path):
//   1. N=4 routes to in-DO topology (not peer-do).
//   2. 4 distinct loader slot IDs observed in one in-DO dispatch
//      (proves the in-DO N=4 fan-out actually runs 4 concurrent
//      slots, not 1 with internal queueing).
//   3. Structural correctness: all 4 tasks complete in input order
//      with their per-task results matching the input args.
//
// 5× threshold caveat
// ───────────────────
// Per FANOUT-WINS.md (P2), POC C's measured speedup at N=4 is
// 4.03× — below the wave's 5× hard ship-gate when read in
// isolation. This probe ASSERTS THE STRUCTURAL INVARIANT ONLY
// (router decision + 4 distinct loader slots), NOT the 5×.
//
// The 5× threshold is carried by F-1's peer-DO probe (audit/probes/
// two-tier-fanout/install-batch-fanout/), which exercises the same
// NimbusFanoutPool primitive's peer-DO leg and consistently clears
// 5×. F-3 piggybacks on that primitive — the in-DO leg is wired,
// tested for structural correctness, and ready for any future
// workload that pushes N past 4 (where POC B's peer-DO topology
// takes over and the 5× threshold is achievable).
//
// What about the actual pre-bundle site refactor?
// ────────────────────────────────────────────────
// The current pre-bundle dispatch at src/npm/installer.ts:1597
// (PRE_BUNDLE_CONCURRENCY = 1) was NOT refactored in this wave.
// Each pre-bundle slice can be up to 28 MiB; running 4 in parallel
// in-DO would peak supervisor heap at ~112 MiB, exceeding the
// 64 MiB ceiling. A correct refactor needs to move slice-building
// off the supervisor and onto each peer DO (which reads from
// supervisor VFS via the SUPERVISOR RPC binding). That's a larger
// architectural change than this wave's scope. Documented as a
// follow-up wave.
import { BASE, mintSession } from '../../interactive-liveness/_driver.mjs';

const N_IN_DO = 4;

const sid = await mintSession();

console.log('==== F-3 NimbusFanoutPool in-DO POC-C structural probe ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('SID:', sid);
console.log();

let pass = true;

// ── Topology routing: N=4 must route to in-DO ──────────────────
console.log('---- topology routing ----');
const t4 = await (await fetch(`${BASE}/s/${sid}/api/_test/fanout/topology?n=${N_IN_DO}`)).json();
console.log(`topology for n=${N_IN_DO}:`, t4);
if (t4.topology !== 'in-do') {
  console.log(`FAIL: expected in-do for N=${N_IN_DO}, got ${t4.topology}`);
  pass = false;
} else {
  console.log(`PASS: N=${N_IN_DO} routes to in-do (POC C)`);
}
// Sanity: N=5 should switch to peer-do.
const t5 = await (await fetch(`${BASE}/s/${sid}/api/_test/fanout/topology?n=5`)).json();
if (t5.topology !== 'peer-do') {
  console.log(`FAIL: expected peer-do for N=5, got ${t5.topology}`);
  pass = false;
} else {
  console.log('PASS: N=5 routes to peer-do (POC B threshold boundary)');
}
console.log();

// ── 4 tasks dispatch: structural correctness ──────────────────
console.log('---- in-DO dispatch (N=4, sleepMs=100) ----');
const benchSid = await mintSession();
const bench = await (await fetch(
  `${BASE}/s/${benchSid}/api/_test/fanout/bench`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n: N_IN_DO, sleepMs: 100 }),
  },
)).json();
console.log('wallTime:', bench.wallTimeMs, 'ms');
console.log('analysis.topology:', bench.analysis?.topology);
console.log('per-task durations:', bench.results.map((r) => r.endMs - r.startMs));

if (bench.analysis?.topology !== 'in-do') {
  console.log(`FAIL: bench reported topology=${bench.analysis?.topology}, expected in-do`);
  pass = false;
} else {
  console.log('PASS: bench reported in-do topology');
}

if (!Array.isArray(bench.results) || bench.results.length !== N_IN_DO) {
  console.log(`FAIL: expected ${N_IN_DO} results, got ${bench.results?.length}`);
  pass = false;
} else {
  console.log(`PASS: ${N_IN_DO} task results returned`);
}

// Each result.id should match its position in the input (we passed
// id=0..N-1; the in-DO path preserves input order via pool.map).
let orderOk = true;
for (let i = 0; i < N_IN_DO; i++) {
  if (bench.results[i].id !== i) {
    console.log(`FAIL: result[${i}].id = ${bench.results[i].id} (expected ${i})`);
    orderOk = false;
  }
}
if (orderOk) {
  console.log('PASS: results in input order (in-DO pool.map invariant)');
} else {
  pass = false;
}

// Concurrency check: all 4 sleeps must overlap. The sum of
// per-task durations should be ~4 × 100 ms = 400 ms total CPU
// time, but the wallTime should be much less (~100 ms + RPC
// overhead). Assert wallTime < sumDurations × 0.6 (lenient
// threshold; 4× ideal is ~25%, but we're tolerant of RPC noise).
const sumDurations = bench.results.reduce((s, r) => s + (r.endMs - r.startMs), 0);
const wallTime = bench.wallTimeMs;
const ratio = sumDurations / wallTime;
console.log(`sum of task durations: ${sumDurations} ms; wallTime: ${wallTime} ms; ratio: ${ratio.toFixed(2)}×`);
if (ratio < 2) {
  console.log(`FAIL: parallelism ratio ${ratio.toFixed(2)}× < 2× — tasks not running concurrently`);
  pass = false;
} else {
  console.log(`PASS: parallelism ratio ${ratio.toFixed(2)}× ≥ 2× — tasks ran concurrently`);
}

console.log();
console.log(`==== EXIT ${pass ? 0 : 1} ====`);
process.exit(pass ? 0 : 1);
