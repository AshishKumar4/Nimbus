#!/usr/bin/env bun
// perf-regression/install-warm — npm install with a 100% warm tarball cache.
//
// User flow timed:
//   1. First `npm install left-pad@1.3.0` seeds the session cache.
//      (excluded from the measurement)
//   2. `rm -rf node_modules` to force the install path.
//   3. `npm install left-pad@1.3.0` again — every tarball should now come
//      from the shared cache rather than the registry. Five samples per
//      session.
//
// What this probe asserts, and why it changed:
//
// It used to bound the CLIENT wall clock at 250 ms against a "median=102 ms
// p95=103 ms" baseline attributed to a baselines.md that has never existed in
// this repository — no target, date, or method was ever recorded for it.
// Measured over 50 interleaved warm installs, the client contributes 62-140 ms
// of that wall clock on its own (HTTPS round-trip, the WebSocket hop, and the
// driver's 50 ms waitFor poll), against a server-side install of 94-263 ms.
// A 103 ms total is therefore not reachable from a client that is not
// colocated with the colo, and the 250 ms bound sat inside the run-to-run
// spread rather than above it: the SAME commit measured 4/12 runs over
// threshold on long-lived staging and 6/12 on a fresh throwaway (p=0.79 for
// the difference), so the verdict was decided by luck and by where the probe
// ran, not by what it measured.
//
// So assert the two things the install itself owns:
//   1. Every tarball came from the cache. This is the direct form of the
//      regression class the timing bound was a proxy for — L2/L3 lookup path
//      lost, or the installer re-fetching when it should skip on a cache hit.
//   2. Server-side install time, read from the installer's own per-phase
//      breakdown, which excludes client round-trip and poll quantization,
//      and the wall clock, for a regression visible to the user outside the
//      install phases.
//
// Both times are graded paired (_paired.mjs): each round runs the flow on
// the baseline's two Previews and the candidate's, at once, and compares
// each session's median over its warm installs. The fixed 400 ms server
// budget and 1500 ms wall ceiling it replaces failed 21 of 565 full runs of
// main commits (10-09..10-16) on unchanged code.

import { mintSession, Terminal, makeAsserter, deleteSession, requestHeaders } from '../_driver.mjs';
import { assertPaired, measurePaired, median, requirePairedTargets } from '../_paired.mjs';

const a = makeAsserter('perf-regression/install-warm');
const arms = requirePairedTargets('perf-regression/install-warm');
console.log(`perf-regression/install-warm — baseline ${arms.a1.base}, ${arms.a2.base}; candidate ${arms.b.base}`);

const ROUNDS = 16;
const WARM_RUNS = 5;

/** Sum the installer's `phases:` line. Values print as `123ms` or `1.2s`. */
function parsePhaseTotal(output) {
  const line = output.match(/phases:.*/)?.[0];
  if (!line) return null;
  const ms = [...line.matchAll(/=(\d+)ms/g)].reduce((t, m) => t + Number(m[1]), 0);
  const s = [...line.matchAll(/=([\d.]+)s/g)].reduce((t, m) => t + Number(m[1]) * 1000, 0);
  // A target predating millisecond phase output prints every sub-second phase
  // as `0.0s`, which would sum to ~0 and pass this probe without measuring
  // anything. Refuse to score that rather than report a silent green.
  if (!/=\d+ms/.test(line) && s === 0) return null;
  return { line, total: ms + s };
}

/**
 * The session's npm cache counters, as /api/_diag/cache reports them: per
 * tier, tarball and packument hits and misses, and `isolate`, the isolate's
 * fingerprint (the counters' module-load time: two sessions in one isolate
 * share it, and share the counters). Null when the target does not answer.
 */
async function cacheCounters(base, sid) {
  const r = await fetch(`${base}/s/${sid}/api/_diag/cache`, { headers: requestHeaders({}, sid), signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!r?.ok) return null;
  const snapshot = await r.json();
  const counts = {};
  for (const [tier, kinds] of Object.entries(snapshot.byTier ?? {})) {
    for (const kind of ['tarball', 'packument']) counts[`${tier}.${kind}`] = (kinds[kind]?.hits ?? 0) + (kinds[kind]?.misses ?? 0);
  }
  return { isolate: snapshot.startedAt, counts };
}

/** What one install moved, `L2.tarball+1 L3.packument+1 …`, and whether its isolate stayed the same. */
function cacheDelta(before, after) {
  if (!before || !after) return 'cache counters unavailable';
  const moved = Object.keys(after.counts).filter((key) => after.counts[key] !== (before.counts[key] ?? 0))
    .map((key) => `${key}+${after.counts[key] - (before.counts[key] ?? 0)}`);
  return `${moved.join(' ') || 'nothing'} (isolate ${after.isolate}${before.isolate === after.isolate ? '' : `, was ${before.isolate}`})`;
}

const result = await measurePaired(arms, ROUNDS, async (target, arm) => {
  const sid = await mintSession(target);
  const t = new Terminal(sid);
  try {
    await t.connect();
    await t.waitForPrompt(30_000);
    // Seed the cache (untimed).
    await t.run('npm install left-pad@1.3.0', 120_000);
    const server = [];
    const wall = [];
    for (let run = 1; run <= WARM_RUNS; run++) {
      await t.run('rm -rf node_modules', 10_000);
      const before = await cacheCounters(target.base, sid);
      const t0 = performance.now();
      const { output } = await t.run('npm install left-pad@1.3.0', 60_000);
      wall.push(performance.now() - t0);
      // Which tier served it (L2, the colo cache; L3, R2), and whether the
      // isolate saw other sessions' npm work meanwhile (more than our one op).
      console.log(`[install-warm] ${arm} ${sid} run ${run}: cache ${cacheDelta(before, await cacheCounters(target.base, sid))}`);
      if (!/from cache|already installed/.test(output)) throw new Error(`${sid} run ${run}: npm install reports no cache hit on the warm session; tail=${JSON.stringify(output.slice(-300))}`);
      // The `R2 cache wins` field is omitted entirely when no tarball won its
      // cache race, so an absent field is the cache path being lost.
      const wins = output.match(/R2 cache wins=(\d+)\/(\d+)/);
      if (!(wins !== null && wins[1] === wins[2] && Number(wins[2]) > 0)) {
        throw new Error(`${sid} run ${run}: not every tarball came from the shared cache (${wins ? `R2 cache wins=${wins[1]}/${wins[2]}` : 'no "R2 cache wins" field'})`);
      }
      const phases = parsePhaseTotal(output);
      if (!phases) throw new Error(`${sid} run ${run}: no scoreable \`phases:\` line, so the server-side time cannot be read`);
      server.push(phases.total);
    }
    return { 'server-side install': median(server), 'install wall clock': median(wall) };
  } finally {
    await t.close();
    await deleteSession(sid);
  }
});

a.check('every candidate warm install is served from the shared cache with a phase breakdown', result.candidateFailures.length === 0,
  result.candidateFailures.map((failure) => `round ${failure.round}: ${failure.error}`).join('; '));
const graded = [assertPaired(a, 'server-side install', result), assertPaired(a, 'install wall clock', result)].every(Boolean);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : graded ? 0 : 2);
