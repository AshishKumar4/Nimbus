// W-A — caches.default in front of R2 packument GET.
//
// Probe semantics
// ───────────────
// Two complementary assertions per run:
//
//   STRUCTURAL (hard ship-gate):
//     N=15 sequential getPackument() calls. After the first call
//     populates L2, subsequent calls MUST hit L2 (not L3 R2).
//     We assert `stats.l3GetsPackument ≤ 1` AND
//     `stats.l2HitsPackument ≥ N - 1`. This proves the L2 wrap is
//     functional independent of wall-clock noise.
//
//   LATENCY (best-effort signal):
//     We also report cold (t[0]) vs warm-tail (median of t[N-5..N-1]).
//     In wrangler dev local mode `caches.default` and the R2 mock
//     both back onto the same disk store, so the latency contrast is
//     LOWER than production by design (production R2 has 30-100 ms
//     regional RTT vs Cache API <1 ms colo hit). We report the
//     local-dev ratio honestly; production-only proof of the 5×
//     drop lives in the retro.
//
// Why two assertions: workerd's `performance.now()` is rounded to
// 1 ms for Spectre mitigation, and the local disk-backed R2 mock
// has comparable latency to the local Cache API mock. The
// structural counter assertion is the primary correctness gate;
// latency is documented as supporting evidence.
import { BASE, mintSession } from '../../interactive-liveness/_driver.mjs';

const N = 15;
const TAIL_WINDOW = 5;
const STRUCTURAL_MIN_L2_HITS = N - 1; // first call goes L3, rest must be L2
const STRUCTURAL_MAX_L3_GETS = 1;      // exactly one L3 read allowed

const sid = await mintSession();

console.log('==== W-A packument L2 probe ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('SID:', sid);

// Build a realistic packument shape (~2 MiB).
const versions = {};
for (let i = 0; i < 5000; i++) {
  versions[`1.0.${i}`] = {
    name: 'pkg-l2-probe',
    version: `1.0.${i}`,
    dist: { integrity: 'sha512-' + 'x'.repeat(80), tarball: `http://r/pkg/-/pkg-1.0.${i}.tgz` },
    dependencies: { 'dep-a': '^1.0.0', 'dep-b': '^2.0.0', 'dep-c': '^3.0.0' },
    description: 'synthetic test payload to mimic real packument size',
  };
}
const payload = JSON.stringify({ name: 'pkg-l2-probe', versions });
console.log(`payload size: ${(payload.length / 1024).toFixed(1)} KiB`);

// Seed: writes to R2 AND purges any prior L2 entry so the next bench
// run starts from a known L3-only state.
const seedRes = await fetch(`${BASE}/s/${sid}/api/_test/cache/packument/seed`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'pkg-l2-probe', payload }),
});
const seedBody = await seedRes.json();
console.log('seed:', seedBody);
if (!seedBody.seeded) {
  console.log('FAIL: seed did not write to R2');
  console.log('==== EXIT 1 ====');
  process.exit(1);
}

const benchRes = await fetch(`${BASE}/s/${sid}/api/_test/cache/packument/bench?name=pkg-l2-probe&n=${N}`);
const bench = await benchRes.json();
console.log('latencies (ms):', bench.latencies);
console.log('null count:    ', bench.nullCount);
console.log('last bytes:    ', bench.lastBytes);
console.log('stats:         ', JSON.stringify(bench.stats));

if (bench.nullCount > 0) {
  console.log(`FAIL: ${bench.nullCount} of ${N} calls returned null — the impl is broken`);
  console.log('==== EXIT 1 ====');
  process.exit(1);
}

// ── STRUCTURAL ASSERTIONS (hard ship-gate) ─────────────────────────
const stats = bench.stats;
let pass = true;

if (stats.l3GetsPackument > STRUCTURAL_MAX_L3_GETS) {
  console.log(`FAIL [structural]: l3GetsPackument=${stats.l3GetsPackument} > ${STRUCTURAL_MAX_L3_GETS}`);
  console.log('  the L2 layer is not absorbing repeat reads');
  pass = false;
} else {
  console.log(`PASS [structural]: l3GetsPackument=${stats.l3GetsPackument} ≤ ${STRUCTURAL_MAX_L3_GETS}`);
}

if (stats.l2HitsPackument < STRUCTURAL_MIN_L2_HITS) {
  console.log(`FAIL [structural]: l2HitsPackument=${stats.l2HitsPackument} < ${STRUCTURAL_MIN_L2_HITS}`);
  console.log('  L2 should serve N-1 of N calls after the cold fill');
  pass = false;
} else {
  console.log(`PASS [structural]: l2HitsPackument=${stats.l2HitsPackument} ≥ ${STRUCTURAL_MIN_L2_HITS}`);
}

// ── LATENCY (hard ship-gate per wave anti-requirement) ────────────
const t = bench.latencies;
const cold = t[0];
const warmSamples = t.slice(N - TAIL_WINDOW);
const warmMedian = median(warmSamples);
const denom = Math.max(warmMedian, 0.5);
const ratio = cold / denom;
console.log(`latency cold (t[0]):                  ${cold.toFixed(2)} ms`);
console.log(`latency warm tail [t[${N - TAIL_WINDOW}..${N - 1}]]:        ${warmSamples.map(x => x.toFixed(1)).join(', ')} ms`);
console.log(`latency warm median:                  ${warmMedian.toFixed(2)} ms`);
console.log(`latency ratio cold / max(warm, 0.5):  ${ratio.toFixed(2)}×`);

const TARGET_RATIO = 5;
if (ratio < TARGET_RATIO) {
  console.log(`FAIL [latency]: ratio ${ratio.toFixed(2)}× < ${TARGET_RATIO}× target`);
  pass = false;
} else {
  console.log(`PASS [latency]: ratio ${ratio.toFixed(2)}× ≥ ${TARGET_RATIO}× target`);
}

console.log(`==== EXIT ${pass ? 0 : 1} ====`);
process.exit(pass ? 0 : 1);

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2
    ? sorted[(n - 1) / 2]
    : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}
