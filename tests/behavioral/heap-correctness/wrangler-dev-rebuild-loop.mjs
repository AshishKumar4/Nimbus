#!/usr/bin/env bun
// heap-correctness/wrangler-dev-rebuild-loop — H7 probe.
//
// Bug: src/session/bindings.ts:194 — _NIMBUS_LOADED_CODES: Map<string, any>
// is module-scoped and grows on every NimbusLoaderRPC.load(...) call.
// Comment says "GC isn't needed" because "inner stubs that reference
// them die with the DO". TRUE for stubs, but the CODE entry stays in
// the Map for the life of the supervisor isolate. Wrangler dev's
// rebuild-on-save loop calls load(...) on every save → the Map grows
// without bound until the supervisor isolate is evicted.
//
// We probe by:
//   1. Bootstrapping a small worker (POST a wrangler.jsonc + index.ts
//      into the VFS).
//   2. Driving N rebuilds via repeated `nimbus-wrangler dev` invocations
//      OR by directly POSTing N tiny worker payloads through the
//      LOADER path. Each POST adds an entry to _NIMBUS_LOADED_CODES.
//   3. Sampling /api/_diag/memory.heap.contributions for the loaded-
//      codes contributor.
//
// Direct-load path is unavailable from black-box (no public POST that
// reaches NimbusLoaderRPC.load). The cleanest observable surface is
// the supervisor's heap counter — if H7 fix lands a real eviction
// strategy, the counter reports a finite ceiling (e.g. LRU 32 entries
// max). Pre-fix it grows monotonically.
//
// Even without driving N loads ourselves, we can still capture the
// CURRENT counter and prove the structural property: there's no
// `loadedCodes` field in heap.contributions today, so the bug is
// invisible to the diagnostics. The fix must add the counter AND the
// eviction.
//
// What we assert:
//
//   GREEN — heap.contributions includes a loadedCodes counter AND
//   /api/_diag/memory exposes the Map size, so the leak is observable
//   and bounded by an eviction policy.
//
//   RED — counter absent (or stays at 0 regardless of activity);
//   structural proof of the bug.

import { mintSession, BASE } from '../_driver.mjs';
import { diagMemory } from './_diag.mjs';

const sid = await mintSession();
console.log(`[H7] sid=${sid} BASE=${BASE}`);

const m = await diagMemory(sid);
const breakdown = m.heap?.breakdown ?? {};
const loadedBytes = breakdown.loadedCodesBytes ?? null;
const ks = Object.keys(breakdown);

const findings = {
  bug: 'H7',
  sid,
  base: BASE,
  breakdownKeys: ks,
  loadedCodesBytes: loadedBytes,
  // The Map's size proper. Some fix variants may surface this at the
  // top level of the diag response.
  loadedCodesEntries: m.loadedCodes?.entries ?? null,
  loadedCodesMaxEntries: m.loadedCodes?.maxEntries ?? null,
  loadedCodesEvictions: m.loadedCodes?.evictions ?? null,
};

console.log(JSON.stringify(findings, null, 2));

const verdict = (() => {
  // After fix we MUST surface either loadedCodesBytes in the breakdown
  // OR an entries counter at top level, AND a documented max so the
  // eviction strategy is visible.
  if (loadedBytes == null && findings.loadedCodesEntries == null) {
    return { state: 'RED', reason: 'no loadedCodes counter in /api/_diag/memory — leak invisible' };
  }
  if (findings.loadedCodesMaxEntries == null) {
    return { state: 'RED', reason: 'no max-entries cap exposed — eviction policy undocumented' };
  }
  return { state: 'GREEN', reason: `loadedCodes counter present (bytes=${loadedBytes}, entries=${findings.loadedCodesEntries}); max=${findings.loadedCodesMaxEntries}` };
})();
console.log(`[H7] ${verdict.state} — ${verdict.reason}`);
process.exit(verdict.state === 'GREEN' ? 0 : 1);
