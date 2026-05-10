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
//      Assert: L1.packument.misses >= 1 (fresh isolate, NpmCache empty)
//              L4.packument.hits >= 1 OR L3.packument.hits >= 1
//              (either origin fetched, or warm R2 served)
//              L1.tarball.misses >= 1 (tarball not in NpmCache yet)
//              L4.tarball.hits >= 1 OR L3.tarball.hits >= 1
//   3. Same session: rm -rf node_modules && npm i clsx. Snapshot again.
//      Assert: L1.tarball.hits increased (NpmCache survived the rm —
//              it's per-DO keyed by name@version, not by file path).
//   4. NEW session B (different sid → different DO instance → fresh
//      isolate, possibly same or different colo): npm i clsx.
//      Snapshot from session B's /api/_diag/cache.
//      Assert: L1.packument.misses >= 1 (B's NpmCache is fresh)
//              L2 OR L3 hit (cross-tenant tiers are global) — i.e.
//              the counter for L4.packument.hits is NOT the only
//              non-zero hit-tier (otherwise we never benefit from
//              the cross-tenant cache).
//
// Black-box driven: only POST /new + WS terminal + GET /api/_diag/cache.
// No /api/_diag/memory (RPC-level counters, separate axis).

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../_driver.mjs';

async function getCacheSnapshot(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cache`);
  if (!r.ok) throw new Error(`GET /api/_diag/cache failed: ${r.status}`);
  return r.json();
}

async function resetCache(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cache/reset`, { method: 'POST' });
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

// Phase-1 invariants. Fresh isolate, fresh NpmCache: L1 MUST have
// recorded ≥1 packument miss (the resolver always queries L1 first
// for clsx's metadata). It also MUST have recorded ≥1 tarball miss
// (the install pipeline queries L1 before fetching).
A.check('L1.packument.misses >= 1 (fresh NpmCache)',
  p1L1Pack.misses >= 1,
  `misses=${p1L1Pack.misses} hits=${p1L1Pack.hits}`);
A.check('L1.tarball.misses >= 1 (fresh NpmCache)',
  p1L1Tarball.misses >= 1,
  `misses=${p1L1Tarball.misses} hits=${p1L1Tarball.hits}`);

// SOMEONE has to have served the bytes — either L4 (fresh registry
// fetch) or L3 (warm R2 from prior installs).
const tarballSourcedFromOriginOrR2 =
  (p1L4Tarball.hits + p1L3Tarball.hits + p1L2Tarball.hits) >= 1;
A.check('clsx tarball sourced from L2/L3/L4 (not all zeros)',
  tarballSourcedFromOriginOrR2,
  `L2=${p1L2Tarball.hits} L3=${p1L3Tarball.hits} L4=${p1L4Tarball.hits}`);

const packumentSourcedFromOriginOrR2 =
  (p1L4Pack.hits + p1L3Pack.hits + p1L2Pack.hits) >= 1;
A.check('clsx packument sourced from L2/L3/L4 (not all zeros)',
  packumentSourcedFromOriginOrR2,
  `L2=${p1L2Pack.hits} L3=${p1L3Pack.hits} L4=${p1L4Pack.hits}`);

// ── Phase 2: rm -rf node_modules + re-install in same session ─────────
console.log(`[hit-rate-tracking] phase 2 — rm node_modules + re-install in session A`);
await tA.run('rm -rf node_modules', 10_000);
await tA.run('npm install clsx', 60_000);

const phase2 = await getCacheSnapshot(sidA);
const p2L1Tarball = sumKind(phase2, 'L1', 'tarball');
const p2L1Pack    = sumKind(phase2, 'L1', 'packument');

console.log(`  phase2 L1 deltas: tarball.hits +${p2L1Tarball.hits - p1L1Tarball.hits} packument.hits +${p2L1Pack.hits - p1L1Pack.hits}`);

// L1.tarball.hits MUST have increased — NpmCache survived the rm,
// the second install gets a fast L1 hit.
A.check('L1.tarball.hits increased after rm + re-install (NpmCache survives rm)',
  p2L1Tarball.hits > p1L1Tarball.hits,
  `phase1 hits=${p1L1Tarball.hits} → phase2 hits=${p2L1Tarball.hits}`);

// L1.packument.hits MUST have increased — the resolver re-asks for
// clsx metadata and now gets a hot L1 hit.
A.check('L1.packument.hits increased after rm + re-install',
  p2L1Pack.hits > p1L1Pack.hits,
  `phase1 hits=${p1L1Pack.hits} → phase2 hits=${p2L1Pack.hits}`);

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

// Session B starts with a fresh per-DO NpmCache, so L1 misses are
// expected.
A.check('phase 3: L1.tarball.misses >= 1 (fresh isolate)',
  p3L1Tarball.misses >= 1,
  `misses=${p3L1Tarball.misses}`);
A.check('phase 3: L1.packument.misses >= 1 (fresh isolate)',
  p3L1Pack.misses >= 1,
  `misses=${p3L1Pack.misses}`);

// CRITICAL invariant: after Phase 1 wrote back to L2/L3, session B's
// install MUST be served by L2 or L3 (not exclusively by L4 — that
// would mean the cross-tenant cache is broken). Either tarball or
// packument is enough; in practice both should hit because Phase 1
// wrote both back. The L2 vs L3 split depends on colo affinity.
const crossTenantHit =
  (p3L2Tarball.hits + p3L3Tarball.hits + p3L2Pack.hits + p3L3Pack.hits) >= 1;
A.check('phase 3: cross-tenant cache (L2 or L3) served at least one lookup',
  crossTenantHit,
  `L2.tarball=${p3L2Tarball.hits} L3.tarball=${p3L3Tarball.hits} L2.packument=${p3L2Pack.hits} L3.packument=${p3L3Pack.hits}`);

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
