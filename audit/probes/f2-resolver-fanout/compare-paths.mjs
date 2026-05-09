#!/usr/bin/env bun
// F-2 baseline-vs-fanout comparison probe.
//
// Runs the same cohort against the LEGACY single-facet resolver
// (NIMBUS_RESOLVER_PATH=facet) and against the F-2 frontier
// coordinator (default), capturing resolver wall time per package
// for each path. Reports per-package speedup and aggregate.
//
// Wrangler-dev cycle: this probe assumes wrangler is already running
// in `fanout` mode (default). It drives the cohort against fanout,
// then PROMPTS the operator to restart wrangler with
//   --var NIMBUS_RESOLVER_PATH:facet
// and re-runs against facet.
//
// To run both paths fully autonomously, use compare-paths.sh which
// kills + restarts wrangler around the run.
//
// Output:
//   audit/probes/f2-resolver-fanout/baseline-facet/<name>.log
//   audit/probes/f2-resolver-fanout/baseline-fanout/<name>.log
//   audit/probes/f2-resolver-fanout/COMPARISON.md
//
// Usage:
//   PATH_LABEL=fanout BASE=http://127.0.0.1:8792 \
//     bun audit/probes/f2-resolver-fanout/compare-paths.mjs
//   (then restart wrangler with NIMBUS_RESOLVER_PATH:facet)
//   PATH_LABEL=facet BASE=http://127.0.0.1:8792 \
//     bun audit/probes/f2-resolver-fanout/compare-paths.mjs
//   PATH_LABEL=summary \
//     bun audit/probes/f2-resolver-fanout/compare-paths.mjs

import { runProbe } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPARISON_MD = path.join(HERE, 'COMPARISON.md');

const PATH_LABEL = process.env.PATH_LABEL || 'fanout';
const VALID_LABELS = new Set(['facet', 'fanout', 'summary']);
if (!VALID_LABELS.has(PATH_LABEL)) {
  console.error(`FATAL: PATH_LABEL must be one of ${[...VALID_LABELS].join(', ')}`);
  process.exit(2);
}

const TARGETS = [
  { name: 'webpack',     pkg: 'webpack' },
  { name: 'drizzle',     pkg: 'drizzle-orm' },
  { name: 'express',     pkg: 'express' },
  { name: 'zod',         pkg: 'zod' },
];
const PER_PKG_TIMEOUT_MS = 600_000;

function parseElapsed(installLog) {
  const lastResolveStart = installLog.lastIndexOf('Resolving ');
  const sliced = lastResolveStart > 0 ? installLog.slice(lastResolveStart) : installLog;
  const fanout = sliced.match(/resolver-fanout:[^\n]*elapsed=([0-9.]+)s/);
  const facet = sliced.match(/resolver-facet:\s+\d+ resolved[^\n]*elapsed=([0-9.]+)s/);
  const pathLine = sliced.includes('path: fanout') ? 'fanout' : (sliced.includes('path: facet') ? 'facet' : 'unknown');
  return {
    resolver_s: fanout ? Number(fanout[1]) : (facet ? Number(facet[1]) : null),
    path: pathLine,
  };
}

function loadCsv(label) {
  const dir = path.join(HERE, `baseline-${label}`);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const t of TARGETS) {
    const f = path.join(dir, `${t.name}.log`);
    if (!fs.existsSync(f)) continue;
    const log = fs.readFileSync(f, 'utf8');
    const parsed = parseElapsed(log);
    rows.push({ name: t.name, pkg: t.pkg, ...parsed });
  }
  return rows;
}

if (PATH_LABEL === 'summary') {
  const facet = loadCsv('facet');
  const fanout = loadCsv('fanout');
  let md = '# F-2 Resolver Path Comparison: facet (baseline) vs fanout (F-2)\n\n';
  md += `Captured: ${new Date().toISOString()}\n\n`;
  md += '## Per-package resolver wall time (s)\n\n';
  md += '| Package | facet (baseline) | fanout (F-2) | Speedup ×    | facet path verified | fanout path verified |\n';
  md += '|---------|------------------|--------------|--------------|---------------------|----------------------|\n';
  let speedupCount = 0, totalSpeedup = 0;
  for (const t of TARGETS) {
    const f = facet.find((r) => r.name === t.name);
    const fa = fanout.find((r) => r.name === t.name);
    const fE = f?.resolver_s ?? null;
    const faE = fa?.resolver_s ?? null;
    let speedup = null;
    if (fE !== null && faE !== null && faE > 0) {
      speedup = +(fE / faE).toFixed(2);
      totalSpeedup += speedup;
      speedupCount++;
    }
    md += `| ${t.pkg} | ${fE ?? 'n/a'} | ${faE ?? 'n/a'} | ${speedup ?? 'n/a'} | ${f?.path ?? '?'} | ${fa?.path ?? '?'} |\n`;
  }
  md += '\n## Aggregate\n\n';
  if (speedupCount > 0) {
    md += `- Average speedup (geometric-ish, simple mean): ${(totalSpeedup / speedupCount).toFixed(2)}×\n`;
  } else {
    md += '- No comparable rows.\n';
  }
  fs.writeFileSync(COMPARISON_MD, md);
  console.log('\n' + md);
  console.log(`\nWrote ${COMPARISON_MD}`);
  process.exit(0);
}

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8792');
  process.exit(2);
}

const OUT = path.join(HERE, `baseline-${PATH_LABEL}`);
fs.mkdirSync(OUT, { recursive: true });

console.log(`==== Run path=${PATH_LABEL} (against BASE=${process.env.BASE}) ====`);
for (const t of TARGETS) {
  const artifactPath = path.join(OUT, `${t.name}.log`);
  console.log(`[START] ${t.name}`);
  const t0 = Date.now();
  await runProbe(`f2-compare-${PATH_LABEL}-${t.name}`, [
    { kind: 'cmd', cmd: `cd /home/user/app && rm -rf node_modules package.json package-lock.json 2>/dev/null; echo '{"name":"f2","version":"0.0.0"}' > package.json && cat package.json`, timeoutMs: 10_000 },
    { kind: 'cmd', cmd: `npm install ${t.pkg}`, timeoutMs: PER_PKG_TIMEOUT_MS, waitFor: /\[npm\] install complete|npm ERR!|installed \d+ packages|added \d+ packages|Done!\s+\d+ packages/i },
  ], { artifactPath, settleMs: 5000 });
  const elapsed = Date.now() - t0;
  const installLog = fs.readFileSync(artifactPath, 'utf8');
  const parsed = parseElapsed(installLog);
  console.log(`[DONE] ${t.name}: path=${parsed.path} resolver_s=${parsed.resolver_s} install_wall_s=${(elapsed / 1000).toFixed(1)}`);
}
console.log(`Done. Output in ${OUT}`);
