// W-D — caches.default in front of env.ASSETS esbuild-wasm fetch.
//
// Probe semantics
// ───────────────
// The wasm path goes through a free function (fetchEsbuildWasmBytes)
// not a class, so there is no per-instance counter to assert
// structurally — the latency assertion stands alone.
//
// LATENCY (hard ship-gate per wave anti-requirement):
//   1. POST /api/_test/cache/wasm/reset — purge L2
//   2. GET  /api/_test/cache/wasm/bench?n=N — N timed reads
//   3. Assert t[0] / median(best-3-of-last-5) ≥ 5×.
//
// The first call after reset goes ASSETS → 12 MiB ArrayBuffer →
// awaited L2 write-back. Subsequent calls hit L2.
//
// Why latency-only here:
//   - fetchEsbuildWasmBytes is a free function; instrumenting it
//     with a per-call counter would change its signature for every
//     existing caller (npm-installer, vite-dev-server). Out of
//     charter for this wave.
//   - The 12 MiB payload makes the wall-clock contrast very
//     visible: cold ~80 ms (ASSETS fetch + L2 put), warm 10-25 ms
//     (L2 read). Even with workerd's noisy local-dev bench shape,
//     the ratio is reliably ≥3× and typically ≥5×.
//
// Reset is REQUIRED because workerd local dev persists
// caches.default state in `.wrangler/state/v3/cache` across
// sessions; without an explicit purge the second probe run sees
// an L2 hit on call 0 and the cold path is unobservable.
import { BASE, mintSession } from '../../interactive-liveness/_driver.mjs';

const N = 8;
const TAIL_WINDOW = 5;
const TARGET_RATIO = 5;

const sid = await mintSession();

console.log('==== W-D esbuild-wasm L2 probe ====');
console.log('==== TIMESTAMP:', new Date().toISOString(), '====');
console.log('BASE:', BASE);
console.log('SID:', sid);

const resetRes = await fetch(`${BASE}/s/${sid}/api/_test/cache/wasm/reset`, { method: 'POST' });
console.log('reset:', await resetRes.json());

const benchRes = await fetch(`${BASE}/s/${sid}/api/_test/cache/wasm/bench?n=${N}`);
const bench = await benchRes.json();
console.log('latencies (ms):', bench.latencies);
console.log('last bytes:    ', bench.lastBytes);

if (!bench.lastBytes || bench.lastBytes !== 11907565) {
  console.log(`FAIL: expected 11907565 bytes, got ${bench.lastBytes}`);
  console.log('==== EXIT 1 ====');
  process.exit(1);
}

const t = bench.latencies;
const cold = t[0];
const warmSamples = t.slice(N - TAIL_WINDOW);
const sortedTail = [...warmSamples].sort((a, b) => a - b);
const warmMedian = median(sortedTail.slice(0, 3));
const denom = Math.max(warmMedian, 0.5);
const ratio = cold / denom;
console.log(`latency cold (t[0]):                  ${cold.toFixed(2)} ms`);
console.log(`latency warm tail [t[${N - TAIL_WINDOW}..${N - 1}]]:        ${warmSamples.map(x => x.toFixed(1)).join(', ')} ms`);
console.log(`latency warm median (best-3-of-5):    ${warmMedian.toFixed(2)} ms`);
console.log(`latency ratio cold / max(warm, 0.5):  ${ratio.toFixed(2)}×`);

let pass = true;
if (cold < 5) {
  console.log(`FAIL: cold path too fast (${cold} ms < 5 ms) — purge probably failed; the probe is not observing the cold path`);
  pass = false;
}
if (ratio < TARGET_RATIO) {
  console.log(`FAIL [latency]: ratio ${ratio.toFixed(2)}× < ${TARGET_RATIO}× target`);
  pass = false;
} else if (cold >= 5) {
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
