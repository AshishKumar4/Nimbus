#!/usr/bin/env bun
// exec-performance/exec-bundle-cache — verifies the prefetch-bundle cache:
// a repeated foreground exec with an unchanged VFS hits the cache (skipping
// the full VFS walk + esbuild pass), and any write under a path the bundle
// reads invalidates it (cacheHit goes back to false).
//
// REQUIRES the worker deployed with NIMBUS_DIAG_EXEC=1 (the cacheHit signal
// is read from /api/_diag/exec telemetry). With the flag off the ring is
// empty and the probe SKIPS.
//
// Correctness claim under test: the cache is keyed on the GLOBAL SqliteVFS
// revision, so it (a) hits on exact repeats with no intervening write and
// (b) invalidates on ANY write — proving it can never serve a stale bundle.
//
// Note: cacheHit is the source of truth here, NOT wall-time. Wall-time on a
// warm isolate is noisy (cold-start, registry, GC); the boolean cacheHit is
// the deterministic behavioral signal. A speedup ASSERTION is documented for
// the parent to confirm from the bundleMs telemetry across many runs.

import { mintSession, Terminal, makeAsserter, stripAnsi, requestHeaders, BASE, deleteSession } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('exec-performance/exec-bundle-cache');
console.log(`exec-performance/exec-bundle-cache — ${BASE}`);

const sid = await mintSession();

async function reset() {
  await fetch(`${BASE}/s/${sid}/api/_diag/exec/reset`, { method: 'POST', headers: requestHeaders() });
}
async function lastRecord() {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/exec`, { headers: requestHeaders() });
  if (r.status !== 200) return null;
  const body = await r.json();
  const recs = Array.isArray(body.records) ? body.records : [];
  return recs.length ? recs[recs.length - 1] : null;
}

try {
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);

  // A stable command whose bundle/manifest is identical across runs.
  const CMD = 'node -e "console.log(\'cache-probe\')"';

  await reset();
  const r1 = await t.run(CMD, 30_000);
  a.check('first run printed', /cache-probe/.test(stripAnsi(r1.output)),
    `tail=${JSON.stringify(stripAnsi(r1.output).slice(-200))}`);
  const rec1 = await lastRecord();

  if (!rec1) {
    console.log('[exec-bundle-cache] SKIP: no telemetry — deploy with NIMBUS_DIAG_EXEC=1.');
    const sum = a.summary();
    process.exit(sum.fail > 0 ? 1 : 0);
  }

  a.check('first run is a cache MISS (cold)', rec1.cacheHit === false,
    `rec1=${JSON.stringify(rec1)}`);

  // Second identical run with NO intervening VFS write — must hit.
  await reset();
  await t.run(CMD, 30_000);
  const rec2 = await lastRecord();
  a.check('repeat run with unchanged VFS is a cache HIT',
    rec2 && rec2.cacheHit === true,
    `rec2=${JSON.stringify(rec2)}`);

  // Now mutate the VFS — ANY write bumps the global revision watermark.
  await t.run('echo invalidate > /home/user/cache-bust.txt', 10_000);

  await reset();
  await t.run(CMD, 30_000);
  const rec3 = await lastRecord();
  a.check('run after a VFS write is a cache MISS (invalidated)',
    rec3 && rec3.cacheHit === false,
    `rec3=${JSON.stringify(rec3)}`);

  console.log(`[exec-bundle-cache] rec1.bundleMs=${rec1.bundleMs} rec2.bundleMs=${rec2 && rec2.bundleMs} (hit) rec3.bundleMs=${rec3 && rec3.bundleMs} (miss)`);
  await t.close();
} finally {
  await deleteSession(sid).catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
