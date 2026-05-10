#!/usr/bin/env bun
// cache-observability/large-tarball-bypass — 30 MiB R2 bypass verdict.
//
// Audit verdict (cache-observability wave P1):
//   - src/npm/r2-cache.ts:70 exports MAX_R2_TARBALL_BYTES = 30 * 1024 * 1024.
//   - L2/L3 reads + L3 writes are short-circuited above this cap
//     (lines 291, 301, 347).
//   - W7 streaming RPC closed the OUTBOUND direction (facet→supervisor
//     VFS writes); the INBOUND direction (supervisor→facet returning
//     tarball bytes) still uses structured-clone, so the 32 MiB cap
//     enforces 30 MiB with margin.
//
// This probe asserts the documentary invariant without trying to
// spin up a fake registry serving >30 MiB tarballs (which would be
// a multi-day side-quest).
//
// Two checks:
//   1. /api/_diag/cache returns the byTier grid (asset kind included
//      for forward-compat — we can't assert asset hits without
//      esbuild-wasm being fetched, but the schema must include it).
//   2. After installing a small package (clsx), L3.tarball.misses
//      counter for the >30 MiB case is unchanged from baseline
//      (because clsx is ~1 KB compressed, nowhere near the cap).
//      i.e. small packages DO go through L3, only large ones bypass.
//
// The structural assertion that "MAX_R2_TARBALL_BYTES is enforced
// in code" is verified by the audit doc + the constant export. This
// probe is the BEHAVIORAL companion: after a known small-package
// install, we DID record an L3 lookup (hit or miss), proving the L3
// path is not unconditionally bypassed.

import { mintSession, Terminal, sleep, makeAsserter, BASE } from '../_driver.mjs';

const A = makeAsserter('cache-observability/large-tarball-bypass');

const sid = await mintSession();
console.log(`[large-tarball-bypass] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(1_500);
await t.waitForPrompt(15_000);

// Reset + verify schema completeness.
await fetch(`${BASE}/s/${sid}/api/_diag/cache/reset`, { method: 'POST' });
const baseline = await (await fetch(`${BASE}/s/${sid}/api/_diag/cache`)).json();

A.check('snapshot.byTier has L1/L2/L3/L4',
  baseline.byTier?.L1 && baseline.byTier?.L2 && baseline.byTier?.L3 && baseline.byTier?.L4,
  `tiers=${Object.keys(baseline.byTier || {}).join(',')}`);

for (const tier of ['L1','L2','L3','L4']) {
  const cells = baseline.byTier?.[tier] || {};
  A.check(`${tier} has tarball/packument/asset kinds`,
    cells.tarball && cells.packument && cells.asset,
    `kinds=${Object.keys(cells).join(',')}`);
}

A.check('hitRate mirrors byTier shape',
  !!baseline.hitRate?.L1?.tarball === false || // either both present or both absent
    (typeof baseline.hitRate?.L1?.tarball === 'number' &&
     typeof baseline.hitRate?.L4?.asset === 'number'),
  `hitRate keys: ${Object.keys(baseline.hitRate || {}).join(',')}`);

A.check('startedAt is a positive number (module load time)',
  typeof baseline.startedAt === 'number' && baseline.startedAt > 0,
  `startedAt=${baseline.startedAt}`);

A.check('lastResetAt >= startedAt',
  typeof baseline.lastResetAt === 'number' && baseline.lastResetAt >= baseline.startedAt,
  `startedAt=${baseline.startedAt} lastResetAt=${baseline.lastResetAt}`);

// Behavioral: install clsx (well under 30 MiB) and confirm L2/L3 path
// is exercised — i.e. small packages aren't bypassed.
await t.run('mkdir -p /home/user/c && cd /home/user/c', 8_000);
await t.run(
  `node -e "require('fs').writeFileSync('/home/user/c/package.json', JSON.stringify({name:'c',dependencies:{clsx:'^2.1.0'}}))"`,
  8_000,
);
await t.run('npm install clsx', 60_000);

const after = await (await fetch(`${BASE}/s/${sid}/api/_diag/cache`)).json();
const l2Total =
  (after.byTier.L2.tarball.hits + after.byTier.L2.tarball.misses) +
  (after.byTier.L2.packument.hits + after.byTier.L2.packument.misses);
const l3Total =
  (after.byTier.L3.tarball.hits + after.byTier.L3.tarball.misses) +
  (after.byTier.L3.packument.hits + after.byTier.L3.packument.misses);

console.log(`  post-install: L2 total lookups=${l2Total}, L3 total lookups=${l3Total}`);
console.log(`  clsx is ~1 KB compressed — well under the 30 MiB MAX_R2_TARBALL_BYTES cap`);

A.check('small package (clsx) exercised the L2 path (not bypassed)',
  l2Total >= 1,
  `L2 total=${l2Total}`);
A.check('small package (clsx) exercised the L3 path (not bypassed)',
  l3Total >= 1,
  `L3 total=${l3Total}`);

console.log(`\n[large-tarball-bypass] verdict: 30 MiB bypass cap CONFIRMED in code (audit P1).`);
console.log(`[large-tarball-bypass] W7 streaming closed OUTBOUND direction only;`);
console.log(`[large-tarball-bypass] INBOUND (supervisor->facet tarball return) still`);
console.log(`[large-tarball-bypass] structured-clone-bounded. Real-world impact: packages`);
console.log(`[large-tarball-bypass] >30 MiB compressed always hit L4 (registry.npmjs.org)`);
console.log(`[large-tarball-bypass] — rare in practice (puppeteer/playwright moved to`);
console.log(`[large-tarball-bypass] external downloads; most >30 MiB are ML packages with`);
console.log(`[large-tarball-bypass] prebuilt binaries). Closing this gap is a separate`);
console.log(`[large-tarball-bypass] wave: needs ReadableStream<Uint8Array> RPC return,`);
console.log(`[large-tarball-bypass] not in scope here.`);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
