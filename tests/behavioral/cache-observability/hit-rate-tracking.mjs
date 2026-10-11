#!/usr/bin/env bun
// cache-observability/hit-rate-tracking — per-tier counters move on install.
//
// Wave: cache-observability (2026-05-10). Validates the counter
// instrumentation works end-to-end against a real deploy.
//
// Probe shape:
//   1. POST /api/_diag/cache/reset (any session) — zero counters globally.
//      Note: counters are PER-DO-isolate singletons; the reset only
//      zeroes the isolate handling that POST. We compensate by reading
//      the snapshot from the same isolate where the install ran.
//   2. Session A: npm i clsx (tiny CJS package, 619 B ESM dist, ~7 KB
//      packument). Wait for install to settle. GET /api/_diag/cache.
//      Assert: L1.packument stays at zero (this resolver bypasses NpmCache)
//              L1.tarball records a lookup; L1/L2/L3/L4 serves its bytes
//              L2/L3/L4 serves the packument
//   3. Same session: rm -rf node_modules && npm i clsx. Snapshot again.
//      Assert: cached-tier hits increased. The verified local tarball store
//              survives rm; a new isolate falls through to L2/L3.
//   4. NEW session B (different sid → different DO instance → fresh
//      isolate, possibly same or different colo): npm i clsx.
//      Snapshot from session B's /api/_diag/cache.
//      Assert: L1.tarball records a lookup, packument still bypasses L1
//              L1/L2/L3 hit (the local store may share an isolate) — i.e.
//              the counter for L4.packument.hits is NOT the only
//              non-zero hit-tier (otherwise we never benefit from
//              the cross-tenant cache).
//
// Black-box driven: only POST /new + WS terminal + GET /api/_diag/cache.
// No /api/_diag/memory (RPC-level counters, separate axis).

import { mintSession, Terminal, sleep, makeAsserter, BASE, requestHeaders } from '../_driver.mjs';

async function getCacheSnapshot(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cache`, {
    headers: requestHeaders({}, sid),
  });
  if (!r.ok) throw new Error(`GET /api/_diag/cache failed: ${r.status}`);
  return r.json();
}

async function resetCache(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cache/reset`, {
    method: 'POST',
    headers: requestHeaders({}, sid),
  });
  if (r.status !== 204) throw new Error(`reset returned ${r.status}`);
}

function sumKind(snap, tier, kind) {
  const cell = snap.byTier?.[tier]?.[kind];
  return cell || { hits: 0, misses: 0, bytes: 0 };
}

const A = makeAsserter('cache-observability/hit-rate-tracking');

// ── Phase 1: session A, fresh install ─────────────────────────────────
console.log(`[hit-rate-tracking] phase 1 — session A, fresh install (BASE=${BASE})`);
const sidA = await mintSession();
console.log(`  sidA=${sidA}`);

const tA = new Terminal(sidA);
await tA.connect();
await sleep(1_500);
await tA.waitForPrompt(15_000);

// Reset counters in session A's isolate.
await resetCache(sidA);
const baselineA = await getCacheSnapshot(sidA);
// All hits + misses should be 0 right after reset (a freshly-minted
// session may have done zero cache lookups yet, OR it may have done
// some during init; reset() zeroes ALL of them).
const baselineTotal = ['L1','L2','L3','L4'].reduce((s, t) =>
  s + ['tarball','packument','asset'].reduce((ss, k) => ss + sumKind(baselineA, t, k).hits + sumKind(baselineA, t, k).misses, 0), 0);
A.check('baseline after reset: all counters at 0', baselineTotal === 0,
  `baselineTotal=${baselineTotal}`);

// Install clsx — tiny CJS package, fast, deterministic.
await tA.run('mkdir -p /home/user/c && cd /home/user/c', 8_000);
await tA.run(
  `node -e "require('fs').writeFileSync('/home/user/c/package.json', JSON.stringify({name:'c',dependencies:{clsx:'^2.1.0'}}))"`,
  8_000,
);
await tA.run('npm install clsx', 90_000);

const phase1 = await getCacheSnapshot(sidA);
const p1L1Tarball = sumKind(phase1, 'L1', 'tarball');
const p1L1Pack    = sumKind(phase1, 'L1', 'packument');
const p1L4Tarball = sumKind(phase1, 'L4', 'tarball');
const p1L4Pack    = sumKind(phase1, 'L4', 'packument');
const p1L3Tarball = sumKind(phase1, 'L3', 'tarball');
const p1L3Pack    = sumKind(phase1, 'L3', 'packument');
const p1L2Tarball = sumKind(phase1, 'L2', 'tarball');
const p1L2Pack    = sumKind(phase1, 'L2', 'packument');

console.log(`  phase1 snapshot:`, JSON.stringify({
  L1: { tarball: p1L1Tarball, packument: p1L1Pack },
  L2: { tarball: p1L2Tarball, packument: p1L2Pack },
  L3: { tarball: p1L3Tarball, packument: p1L3Pack },
  L4: { tarball: p1L4Tarball, packument: p1L4Pack },
}, null, 0));

// Phase-1 invariants — cache-obs-2 acceptance gate.
//
// v1 captured-and-drained L2/L3/L4 events because DO recursion guard
// blocked the forward path. v2 fixes this by routing events through
// FACET RETURN VALUES (recordR2RaceCounters pattern). The probe now
// asserts non-zero shared-tier hits and the new local tarball lookup.
// The resolver still bypasses NpmCache, so its L1 packument cells stay zero.
A.check('L1 records the tarball lookup while packument resolution bypasses it',
  p1L1Tarball.hits + p1L1Tarball.misses >= 1 &&
  p1L1Pack.hits === 0 && p1L1Pack.misses === 0,
  `L1.tarball=${JSON.stringify(p1L1Tarball)} L1.packument=${JSON.stringify(p1L1Pack)}`);

// CACHE-OBS-2 ACCEPTANCE — at least ONE of L2/L3/L4 across both
// kinds must be non-zero. The clsx tarball is ~3.9 KB and the
// packument is ~42 KB; SOMETHING sourced those bytes. Either:
//   - L2 hit (warm colo cache from prior installs) → expected steady-state
//   - L3 hit (R2 warm, L2 cold) → expected on colo migration
//   - L4 hit (registry.npmjs.org) → first install ever / cold-everything
const outerTierActivity =
  p1L2Tarball.hits + p1L2Pack.hits +
  p1L3Tarball.hits + p1L3Pack.hits +
  p1L4Tarball.hits + p1L4Pack.hits;
A.check('cache-obs-2 acceptance: L2/L3/L4 hits NON-ZERO after install',
  outerTierActivity >= 1,
  `L2.t.hits=${p1L2Tarball.hits} L2.p.hits=${p1L2Pack.hits} ` +
  `L3.t.hits=${p1L3Tarball.hits} L3.p.hits=${p1L3Pack.hits} ` +
  `L4.t.hits=${p1L4Tarball.hits} L4.p.hits=${p1L4Pack.hits}`);

// Both tarball AND packument should have been fetched from SOME
// tier. Asserts both kinds got served (otherwise the install
// somehow completed without seeing one of them, which is wrong).
const tarballServed =
  p1L1Tarball.hits + p1L2Tarball.hits + p1L3Tarball.hits + p1L4Tarball.hits;
const packumentServed =
  p1L2Pack.hits + p1L3Pack.hits + p1L4Pack.hits;
A.check('tarball sourced from at least one of L1/L2/L3/L4',
  tarballServed >= 1,
  `L1=${p1L1Tarball.hits} L2=${p1L2Tarball.hits} L3=${p1L3Tarball.hits} L4=${p1L4Tarball.hits}`);
A.check('packument sourced from at least one of L2/L3/L4',
  packumentServed >= 1,
  `L2=${p1L2Pack.hits} L3=${p1L3Pack.hits} L4=${p1L4Pack.hits}`);

// ── Phase 2: rm -rf node_modules + re-install in same session ─────────
console.log(`[hit-rate-tracking] phase 2 — rm node_modules + re-install in session A`);
await tA.run('rm -rf node_modules', 10_000);
await tA.run('npm install clsx', 60_000);

const phase2 = await getCacheSnapshot(sidA);
const p2L1Tarball = sumKind(phase2, 'L1', 'tarball');
const p2L1Pack    = sumKind(phase2, 'L1', 'packument');
const p2L2Tarball = sumKind(phase2, 'L2', 'tarball');
const p2L2Pack    = sumKind(phase2, 'L2', 'packument');
const p2L3Tarball = sumKind(phase2, 'L3', 'tarball');
const p2L3Pack    = sumKind(phase2, 'L3', 'packument');

console.log(`  phase2 deltas: L1.tarball.hits +${p2L1Tarball.hits - p1L1Tarball.hits} L2.tarball.hits +${p2L2Tarball.hits - p1L2Tarball.hits} L2.packument.hits +${p2L2Pack.hits - p1L2Pack.hits}`);

// Reinstallation must use a cache tier. Local verified bytes no longer
// require an L2 read; eviction or migration can use the external tiers.
const cachedDelta =
  (p2L1Tarball.hits - p1L1Tarball.hits) +
  (p2L1Pack.hits - p1L1Pack.hits) +
  (p2L2Tarball.hits - p1L2Tarball.hits) +
  (p2L2Pack.hits - p1L2Pack.hits) +
  (p2L3Tarball.hits - p1L3Tarball.hits) +
  (p2L3Pack.hits - p1L3Pack.hits);
A.check('phase 2: L1/L2/L3 cache served re-install (delta >= 1)',
  cachedDelta >= 1,
  `cached.delta=${cachedDelta} L1.tarball.delta=${p2L1Tarball.hits - p1L1Tarball.hits}`);

await tA.close();

// ── Phase 3: NEW session B, fresh isolate, cross-tenant tiers active ──
console.log(`[hit-rate-tracking] phase 3 — fresh session B`);
const sidB = await mintSession();
console.log(`  sidB=${sidB}`);

const tB = new Terminal(sidB);
await tB.connect();
await sleep(1_500);
await tB.waitForPrompt(15_000);

await resetCache(sidB);

await tB.run('mkdir -p /home/user/c && cd /home/user/c', 8_000);
await tB.run(
  `node -e "require('fs').writeFileSync('/home/user/c/package.json', JSON.stringify({name:'c',dependencies:{clsx:'^2.1.0'}}))"`,
  8_000,
);
await tB.run('npm install clsx', 90_000);

const phase3 = await getCacheSnapshot(sidB);
const p3L1Tarball = sumKind(phase3, 'L1', 'tarball');
const p3L1Pack    = sumKind(phase3, 'L1', 'packument');
const p3L2Tarball = sumKind(phase3, 'L2', 'tarball');
const p3L2Pack    = sumKind(phase3, 'L2', 'packument');
const p3L3Tarball = sumKind(phase3, 'L3', 'tarball');
const p3L3Pack    = sumKind(phase3, 'L3', 'packument');
const p3L4Tarball = sumKind(phase3, 'L4', 'tarball');
const p3L4Pack    = sumKind(phase3, 'L4', 'packument');

console.log(`  phase3 snapshot:`, JSON.stringify({
  L1: { tarball: p3L1Tarball, packument: p3L1Pack },
  L2: { tarball: p3L2Tarball, packument: p3L2Pack },
  L3: { tarball: p3L3Tarball, packument: p3L3Pack },
  L4: { tarball: p3L4Tarball, packument: p3L4Pack },
}, null, 0));

// Session B may share the verified local tarball store's isolate; if not,
// the cross-tenant tiers warmed by A serve it. Packument resolution still
// bypasses the per-DO metadata cache for this explicit install shape.
A.check('phase 3: L1 records the tarball lookup, not a packument lookup',
  p3L1Tarball.hits + p3L1Tarball.misses >= 1 &&
  p3L1Pack.hits === 0 && p3L1Pack.misses === 0,
  `L1.tarball=${JSON.stringify(p3L1Tarball)} L1.packument=${JSON.stringify(p3L1Pack)}`);

// CRITICAL cache-obs-2 invariant: a cache (local L1, L2 or L3)
// MUST serve session B. Session A warmed those tiers; if session
// B sees L4-only hits, the cross-tenant cache is broken OR the
// counters lost the events. Either is a bug.
const p3CrossTenant =
  p3L1Tarball.hits + p3L2Tarball.hits + p3L3Tarball.hits +
  p3L2Pack.hits + p3L3Pack.hits;
A.check('phase 3: L1/L2/L3 cache served at least one lookup',
  p3CrossTenant >= 1,
  `L1.t=${p3L1Tarball.hits} L2.t=${p3L2Tarball.hits} L3.t=${p3L3Tarball.hits} L2.p=${p3L2Pack.hits} L3.p=${p3L3Pack.hits}`);

await tB.close();

// ── Phase 4: derived hitRate sanity ───────────────────────────────────
console.log(`[hit-rate-tracking] phase 4 — derived hitRate sanity`);
// Every cell with (hits + misses) > 0 should have a hitRate in [0,1]
// matching hits / (hits + misses).
let allRatesOk = true;
let badRates = [];
for (const tier of ['L1','L2','L3','L4']) {
  for (const kind of ['tarball','packument','asset']) {
    const cell = sumKind(phase3, tier, kind);
    const total = cell.hits + cell.misses;
    const expected = total === 0 ? 0 : cell.hits / total;
    const actual = phase3.hitRate?.[tier]?.[kind] ?? -1;
    if (Math.abs(actual - expected) > 1e-9) {
      allRatesOk = false;
      badRates.push(`${tier}.${kind}: expected=${expected.toFixed(3)} got=${actual}`);
    }
  }
}
A.check('hitRate matches hits/(hits+misses) for every cell',
  allRatesOk,
  badRates.slice(0, 3).join(' | '));

const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
