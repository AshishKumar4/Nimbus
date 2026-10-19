#!/usr/bin/env bun
// behavioral/property-cohort — install the top-N npm cohort one-by-one
// in a fresh session each; the property under test is "no install
// crashes the session": each session, after its install, still runs a
// command, whatever the install's own status. A package's install may
// fail (an npm error is a status), but a terminal that closes or stops
// answering is a crash, and every crash fails the probe. This is a
// generative property test (not a per-package strict-pass matrix; that's
// the X.5 cohort — a layer-1 concern).
//
// Black-box surfaces only. NO _diag, NO heap inspection.
//
// Reduced to 6 packages by default to keep wall-clock under 12 min;
// override with NIMBUS_COHORT=full to run the top-30.

import { hasOutputLine, mintSession, Terminal, makeAsserter } from './_driver.mjs';

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

/** Each package's outcome: 'installed' (status 0), 'install-failed' (another status, the session alive after), or 'crashed'. */
const results = [];

for (const pkg of COHORT) {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  let outcome = 'crashed';
  let elapsed = 0;
  let detail = '';
  try {
    await t.run('mkdir -p /home/user/cohort && cd /home/user/cohort', 10_000);
    await t.run('echo \'{"name":"c","version":"0.0.0"}\' > package.json', 10_000);
    const r = await t.run(`npm install ${pkg.pkg}`, 240_000);
    elapsed = r.elapsed;
    // The same session answers after the install, with output its command echo cannot supply.
    const after = await t.run('echo "cohort-alive-$((6 * 7))"', 30_000);
    if (!hasOutputLine(after.output, 'cohort-alive-42')) {
      detail = `the session did not answer after the install: ${JSON.stringify(after.output.slice(-200))}`;
    } else if (r.exitCode === 0) {
      outcome = 'installed';
    } else {
      outcome = 'install-failed';
      detail = `npm install exited ${r.exitCode}: ${r.output.slice(-200)}`;
    }
  } catch (e) {
    detail = String(e?.message ?? e).slice(0, 400);
  } finally {
    await t.close();
  }
  results.push({ pkg: pkg.pkg, outcome, elapsed, detail });
  console.log(`  ${outcome === 'installed' ? '✓' : '✗'} ${pkg.pkg.padEnd(15)} ${(elapsed/1000).toFixed(1).padStart(6)}s ${outcome} ${detail.slice(0, 120)}`);
}

const installed = results.filter((r) => r.outcome === 'installed');
const crashed = results.filter((r) => r.outcome === 'crashed');
a.check(`no install crashed its session (${crashed.length} of ${results.length} did)`,
  crashed.length === 0,
  crashed.map((r) => `${r.pkg}: ${r.detail}`).join('\n'));
a.check(`≥80% of cohort installed (got ${installed.length}/${results.length})`,
  installed.length / results.length >= 0.8,
  JSON.stringify(results.map(({ pkg, outcome }) => ({ pkg, outcome }))));

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
