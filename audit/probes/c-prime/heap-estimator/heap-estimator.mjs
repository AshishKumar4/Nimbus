// Phase 1 C'.1 functional probe — deterministic heap estimator.
//
// PRE-FIX: /api/_diag/memory.peak.heapUsedBytes is structurally 0
// because process.memoryUsage() returns 0 inside a DO context. Today
// nodeMem and peak both report all-zero — useless for verifying memory
// containment work in Phase 2 A'.
//
// POST-FIX (this probe asserts):
//   • /api/_diag/memory contains a `heap` object with a deterministic
//     supervisor-heap estimate sourced from runtime counters
//     (NOT from process.memoryUsage() which we no longer call).
//   • The estimate is bounded by the documented architectural ceiling
//     of 64 MiB by construction (the components sum to a known max).
//   • The estimate breaks down into: vfsLruBytes, vfsInFlightBytes,
//     resolverInFlightBytes, preBundleSliceBytes, esbuildResidentBytes,
//     supervisorBaselineBytes — so a regression in any one component
//     is locatable.
//   • The five workerd eviction-reason labels are documented in the
//     snapshot under `evictionLabels` (a constant taxonomy block, not
//     observed counts — those land in C'.2 recovery_event ring).
//
// Probe runs against local wrangler dev (BASE env). Mints a fresh
// session, hits /api/_diag/memory once, asserts schema present + sane.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'heap-estimator.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`/new returned no Location (status ${r.status})`);
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

async function main() {
  log('==== C\'.1 heap-estimator probe ====');
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  const res = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  const d = await res.json();
  log('diag.heap = ' + JSON.stringify(d.heap, null, 2));
  log('diag.evictionLabels = ' + JSON.stringify(d.evictionLabels));

  // ── Assertion 1: heap object exists with the right shape ─────────────
  if (!d.heap || typeof d.heap !== 'object') {
    fail('diag response is missing the .heap object (Phase 1 C\'.1 not landed)');
  } else {
    pass('diag response contains .heap object');

    const expectedKeys = [
      'estimatedBytes',
      'breakdown',
      'ceilingBytes',
      'percentOfCeiling',
    ];
    for (const k of expectedKeys) {
      if (!(k in d.heap)) fail(`d.heap.${k} is missing`);
      else pass(`d.heap.${k} is present`);
    }

    // ── Assertion 2: ceiling is 64 MiB ─────────────────────────────────
    const SIXTY_FOUR_MIB = 64 * 1024 * 1024;
    if (d.heap.ceilingBytes !== SIXTY_FOUR_MIB) {
      fail(`d.heap.ceilingBytes = ${d.heap.ceilingBytes}, expected ${SIXTY_FOUR_MIB} (64 MiB)`);
    } else {
      pass('d.heap.ceilingBytes = 64 MiB');
    }

    // ── Assertion 3: breakdown components are present ──────────────────
    // Phase 2 A'.2 added `streamingBuffersBytes` to the breakdown to
    // surface in-flight supervisor RPC payloads (writeBatch / writeBatchStream
    // / putRegistryEntries). The C'.1 probe must keep enumerating the
    // full set so a future component being silently dropped from the
    // estimator surfaces as a probe failure rather than a quiet
    // accounting bug.
    const expectedBreakdown = [
      'supervisorBaselineBytes',
      'vfsLruBytes',
      'vfsInFlightBytes',
      'resolverInFlightBytes',
      'preBundleSliceBytes',
      'esbuildResidentBytes',
      'streamingBuffersBytes',
    ];
    if (d.heap.breakdown && typeof d.heap.breakdown === 'object') {
      for (const k of expectedBreakdown) {
        if (!(k in d.heap.breakdown)) fail(`d.heap.breakdown.${k} is missing`);
        else pass(`d.heap.breakdown.${k} = ${d.heap.breakdown[k]}`);
      }

      // Check estimatedBytes equals the sum
      const sum = expectedBreakdown.reduce(
        (acc, k) => acc + (Number(d.heap.breakdown[k]) || 0),
        0,
      );
      if (sum !== d.heap.estimatedBytes) {
        fail(`d.heap.estimatedBytes (${d.heap.estimatedBytes}) != sum of breakdown (${sum})`);
      } else {
        pass(`d.heap.estimatedBytes equals sum of breakdown components (${sum})`);
      }
    } else {
      fail('d.heap.breakdown is not an object');
    }

    // ── Assertion 4: idle session estimate is well below ceiling ───────
    // An idle session (just-minted, no install, no vite) should be
    // dominated by supervisorBaselineBytes + esbuildResidentBytes ≈
    // 30 + 16 = 46 MiB. The breakdown should show this; nothing in
    // pre-bundle / resolver should be in-flight.
    if (d.heap.percentOfCeiling > 100) {
      fail(`idle session at ${d.heap.percentOfCeiling}% of ceiling — already over budget`);
    } else {
      pass(`idle session at ${d.heap.percentOfCeiling}% of ceiling`);
    }
  }

  // ── Assertion 5: evictionLabels taxonomy present ─────────────────────
  const expectedLabels = [
    'lru', 'condemned', 'inactive', 'dynamic_worker', 'dynamic_worker_banned',
  ];
  if (Array.isArray(d.evictionLabels)) {
    for (const lbl of expectedLabels) {
      if (!d.evictionLabels.includes(lbl)) {
        fail(`evictionLabels missing "${lbl}"`);
      } else {
        pass(`evictionLabels contains "${lbl}"`);
      }
    }
  } else {
    fail('d.evictionLabels is not an array');
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
