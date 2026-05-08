// Phase 2 A'.5 probe — esbuild-wasm bytes are NOT resident in supervisor.
//
// Acceptance bar (per Phase 2 charter):
//   idle heap.breakdown.esbuildResidentBytes ≤ 1 MiB (down from 16 MiB)
//
// Pre-fix: esbuild-wasm-bytes.ts caches the decoded ArrayBuffer in
// module scope for the lifetime of the supervisor isolate. The
// estimator attributes a constant 16 MiB to esbuildResidentBytes.
//
// Post-fix: src/esbuild-wasm-bytes.ts fetches from env.ASSETS on
// demand; supervisor heap holds the bytes only briefly during
// pool construction. At idle (no pool active) the residency
// is zero.
//
// The estimator constant ESBUILD_RESIDENT_BYTES drops to 0 once
// the cache is removed. This probe asserts the value flowing
// through /api/_diag/memory.heap.breakdown.esbuildResidentBytes
// matches that constant — i.e. ≤ 1 MiB.
//
// Bonus assertion: total estimatedBytes idle drops by ≥15 MiB
// (the 16 MiB cache plus the ~21 MiB base64 string in the worker
// bundle, depending on whether the base64 is dropped from the
// generated module).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'esbuild-bytes.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

const ONE_MIB = 1 * 1024 * 1024;

async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`/new returned no Location (status ${r.status})`);
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

async function getDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  if (!r.ok) throw new Error(`diag fetch failed: ${r.status}`);
  return r.json();
}

async function main() {
  log("==== A'.5 esbuild-bytes probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  const d = await getDiag(sid);
  if (!d.heap || !d.heap.breakdown) {
    fail("/api/_diag/memory missing heap.breakdown — Phase 1 C'.1 not landed?");
    log('==== EXIT ' + exitCode + ' ====');
    process.exit(exitCode);
  }

  const esbuildBytes = d.heap.breakdown.esbuildResidentBytes;
  const totalBytes = d.heap.estimatedBytes;
  const baselineBytes = d.heap.breakdown.supervisorBaselineBytes;
  const pct = d.heap.percentOfCeiling;

  log(`heap.estimatedBytes:            ${totalBytes}  (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
  log(`heap.percentOfCeiling:          ${pct}%`);
  log(`breakdown.esbuildResidentBytes: ${esbuildBytes}  (${(esbuildBytes / 1024 / 1024).toFixed(1)} MiB)`);
  log(`breakdown.supervisorBaseline:   ${baselineBytes}  (${(baselineBytes / 1024 / 1024).toFixed(1)} MiB)`);

  // Primary assertion: idle esbuildResidentBytes ≤ 1 MiB.
  if (esbuildBytes <= ONE_MIB) {
    pass(`esbuildResidentBytes = ${(esbuildBytes / 1024 / 1024).toFixed(1)} MiB ≤ 1 MiB ceiling`);
  } else {
    fail(`esbuildResidentBytes = ${(esbuildBytes / 1024 / 1024).toFixed(1)} MiB > 1 MiB ceiling — A'.5 not landed`);
  }

  // Bonus assertion: idle heap is comfortably under 50% of the 64 MiB
  // ceiling. Pre-A'.5 we observed 71.9%; post-A'.5 with esbuild moved
  // out of supervisor we expect ≤ 50% (and ideally lower if the base64
  // string is also dropped from the generated module).
  if (pct <= 50) {
    pass(`idle heap percentOfCeiling = ${pct}% ≤ 50%`);
  } else {
    fail(`idle heap percentOfCeiling = ${pct}% > 50% — Phase 2 cumulative target not yet met`);
  }

  // Sum-equals-total invariant must still hold.
  const sum = baselineBytes
    + d.heap.breakdown.vfsLruBytes
    + d.heap.breakdown.vfsInFlightBytes
    + d.heap.breakdown.resolverInFlightBytes
    + d.heap.breakdown.preBundleSliceBytes
    + d.heap.breakdown.esbuildResidentBytes;
  if (sum === totalBytes) {
    pass(`breakdown components sum to estimatedBytes (${sum})`);
  } else {
    fail(`breakdown sum ${sum} != estimatedBytes ${totalBytes} — accounting bug`);
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
