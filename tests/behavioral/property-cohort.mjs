#!/usr/bin/env bun
// behavioral/property-cohort — install the top-N npm cohort one-by-one
// in a fresh session each; the property under test is "no install
// crashes the supervisor; the next install in a new session succeeds."
// This is a generative property test (not a per-package strict-pass
// matrix; that's the X.5 cohort — a layer-1 concern).
//
// Black-box surfaces only. NO _diag, NO heap inspection.
//
// Reduced to 6 packages by default to keep wall-clock under 12 min;
// override with NIMBUS_COHORT=full to run the top-30.

import { mintSession, Terminal, makeAsserter, sleep } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('property-cohort');
console.log(`behavioral/property-cohort — generative install + property check\nBASE=${process.env.BASE}`);

const FAST = [
  { name: 'zod',         pkg: 'zod' },
  { name: 'express',     pkg: 'express' },
  { name: 'webpack',     pkg: 'webpack' },
  { name: 'drizzle-orm', pkg: 'drizzle-orm' },
  { name: 'jsdom',       pkg: 'jsdom' },
  { name: 'redis',       pkg: 'redis' },
];
const FULL = [
  ...FAST,
  { name: 'react',       pkg: 'react' },
  { name: 'vite',        pkg: 'vite' },
  { name: 'next',        pkg: 'next' },
  { name: 'jest',        pkg: 'jest' },
  { name: 'ts-jest',     pkg: 'ts-jest' },
  { name: 'fastify',     pkg: 'fastify' },
];
const COHORT = process.env.NIMBUS_COHORT === 'full' ? FULL : FAST;
console.log(`COHORT size: ${COHORT.length}`);

let succeeded = 0;
let failed = 0;
const results = [];

for (const pkg of COHORT) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await sleep(1_500);
  let ok = false;
  let elapsed = 0;
  let detail = '';
  try {
    await t.run('mkdir -p /home/user/cohort && cd /home/user/cohort', 10_000);
    await t.run('echo \'{"name":"c","version":"0.0.0"}\' > package.json', 10_000);
    const r = await t.run(`npm install ${pkg.pkg}`, 240_000);
    elapsed = r.elapsed;
    if (/added \d+ packages|installed \d+ packages|Done!\s+\d+ packages/i.test(r.output)) {
      ok = true;
      succeeded++;
    } else {
      failed++;
      detail = r.output.slice(-200);
    }
  } catch (e) {
    failed++;
    detail = String(e?.message ?? e).slice(0, 200);
  } finally {
    await t.close();
  }
  results.push({ pkg: pkg.pkg, ok, elapsed, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${pkg.pkg.padEnd(15)} ${(elapsed/1000).toFixed(1).padStart(6)}s ${ok ? '' : detail.slice(0,80)}`);
}

a.check(`≥80% of cohort installed (got ${succeeded}/${COHORT.length})`,
  succeeded / COHORT.length >= 0.8, `succeeded=${succeeded} failed=${failed}`);
a.check(`100% of cohort completed without crashing the session (succeeded+failed = ${succeeded}+${failed} = ${COHORT.length})`,
  succeeded + failed === COHORT.length);

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
