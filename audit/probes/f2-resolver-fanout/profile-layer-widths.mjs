#!/usr/bin/env bun
// F-2 resolver fan-out profiler.
//
// Drives `npm install` for a small cohort against local wrangler dev with
// NIMBUS_DIAG_INSTALL_PIPELINE=1 set on the worker. The resolver
// (resolver.ts + resolve-facet.ts) emits `[f2-layer-width] N=k width=w …`
// lines into the install log. We capture stdout via WS, parse the lines,
// and compute the BFS-frontier width distribution.
//
// Decision rule (per audit/sections/F2-RESOLVER-FANOUT-plan.md):
//   - max width <  IN_DO_THRESHOLD (5)  →  in-DO POC-C is enough; defer F-2.
//   - max width >= IN_DO_THRESHOLD       →  measure if resolver is the
//                                           pipeline bottleneck post-W7+caches.
//
// Output:
//   audit/probes/f2-resolver-fanout/per-package/<name>.log   raw install log
//   audit/probes/f2-resolver-fanout/widths.jsonl              one row per pkg
//   audit/probes/f2-resolver-fanout/SUMMARY.md                rendered table
//
// Usage:
//   BASE=http://127.0.0.1:8792 bun audit/probes/f2-resolver-fanout/profile-layer-widths.mjs
//   BASE=http://127.0.0.1:8792 bun audit/probes/f2-resolver-fanout/profile-layer-widths.mjs --only=vite
//
// IMPORTANT: wrangler dev MUST be started with NIMBUS_DIAG_INSTALL_PIPELINE=1
// (e.g. via --var NIMBUS_DIAG_INSTALL_PIPELINE:1) — without it, the resolver
// emits zero `[f2-layer-width]` lines.

import { runProbe, nodeEvalBase64 } from '../_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PER_DIR = path.join(HERE, 'per-package');
const WIDTHS_JSONL = path.join(HERE, 'widths.jsonl');
const SUMMARY_MD = path.join(HERE, 'SUMMARY.md');
fs.mkdirSync(PER_DIR, { recursive: true });
fs.writeFileSync(WIDTHS_JSONL, '');

if (!process.env.BASE) {
  console.error('FATAL: must set BASE=http://127.0.0.1:8792 explicitly so we hit local wrangler-dev with NIMBUS_DIAG_INSTALL_PIPELINE=1.');
  process.exit(2);
}

// Subset of the post-phase5-verification top-30 chosen for variety in
// dependency-graph shape. vite/webpack have wide trees (150-250 deps);
// express has a medium tree (~50); drizzle-orm has a few transitive
// deps + an X.5-drizzle best-effort optional-peer subtree (key
// regression target); zod has almost no deps. 5 packages keeps total
// runtime under 15 minutes for a single dev-wrangler instance.
const TARGETS = [
  { name: 'vite',        pkg: 'vite' },          // wide tree
  { name: 'webpack',     pkg: 'webpack' },        // deep tree
  { name: 'drizzle',     pkg: 'drizzle-orm' },    // X.5-drizzle regression target
  { name: 'express',     pkg: 'express' },        // medium
  { name: 'zod',         pkg: 'zod' },            // leaf-ish
];
const PER_PKG_TIMEOUT_MS = 480_000;

const onlyName = process.argv.find(a => a.startsWith('--only='))?.split('=')[1];
const targets = onlyName ? TARGETS.filter(t => t.name === onlyName) : TARGETS;

function parseWidths(installLog) {
  // Layer widths come from EITHER:
  //   [f2-layer-width] N=0 width=2 queueRemain=0 resolved=0 seen=2  (legacy single-facet)
  //   [f2-frontier]    N=0 width=2 resolved-so-far=0 seen=2          (F-2 frontier coordinator)
  const layers = [];
  const rxLegacy = /\[f2-layer-width\]\s+N=(\d+)\s+width=(\d+)\s+queueRemain=(\d+)\s+resolved=(\d+)\s+seen=(\d+)/g;
  const rxFrontier = /\[f2-frontier\]\s+N=(\d+)\s+width=(\d+)\s+resolved-so-far=(\d+)\s+seen=(\d+)/g;
  let m;
  while ((m = rxLegacy.exec(installLog)) !== null) {
    layers.push({ source: 'legacy', n: Number(m[1]), width: Number(m[2]), queueRemain: Number(m[3]), resolved: Number(m[4]), seen: Number(m[5]) });
  }
  while ((m = rxFrontier.exec(installLog)) !== null) {
    layers.push({ source: 'frontier', n: Number(m[1]), width: Number(m[2]), queueRemain: 0, resolved: Number(m[3]), seen: Number(m[4]) });
  }
  return layers;
}

function parseResolverElapsed(installLog) {
  // resolver-fanout: 1 resolved, 1 packuments fetched (3.4 MiB), peak in-flight=1, cache writes=6, layers=1, elapsed=0.3s
  // resolver-facet:  1 resolved, 1 packuments fetched (3.4 MiB), peak in-flight=1, cache writes=6, elapsed=0.2s
  const rxFanout = /resolver-fanout:[^\n]*elapsed=([0-9.]+)s/;
  const rxFacet = /resolver-facet:\s+\d+ resolved[^\n]*elapsed=([0-9.]+)s/;
  const fanout = installLog.match(rxFanout);
  const facet = installLog.match(rxFacet);
  return {
    fanout_s: fanout ? Number(fanout[1]) : null,
    facet_s: facet ? Number(facet[1]) : null,
  };
}

function pct(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

const allRows = [];

for (const t of targets) {
  const artifactPath = path.join(PER_DIR, `${t.name}.log`);
  console.log(`[START] ${t.name}`);
  const t0 = Date.now();
  const r = await runProbe(`f2-profile-${t.name}`, [
    { kind: 'cmd', cmd: `cd /home/user/app && rm -rf node_modules package.json package-lock.json 2>/dev/null; echo '{"name":"f2","version":"0.0.0"}' > package.json && cat package.json`, timeoutMs: 10_000 },
    { kind: 'cmd', cmd: `npm install ${t.pkg}`, timeoutMs: PER_PKG_TIMEOUT_MS, waitFor: /\[npm\] install complete|npm ERR!|installed \d+ packages|added \d+ packages|Done!\s+\d+ packages/i },
  ], { artifactPath, settleMs: 5000 });
  const elapsed = Date.now() - t0;

  const installLog = fs.readFileSync(artifactPath, 'utf8');
  // Only the most-recent install (last `npm install` block) is what
  // we measure. Truncate at last "Resolving N dependencies" header.
  const lastResolveStart = installLog.lastIndexOf('Resolving ');
  const sliced = lastResolveStart > 0 ? installLog.slice(lastResolveStart) : installLog;
  const layers = parseWidths(sliced);
  const widths = layers.map((l) => l.width);
  const elapsedShape = parseResolverElapsed(sliced);
  const resolverPath = sliced.includes('path: fanout') ? 'fanout' : (sliced.includes('path: facet') ? 'facet' : 'unknown');
  const row = {
    name: t.name,
    pkg: t.pkg,
    elapsed_ms: elapsed,
    path: resolverPath,
    resolver_elapsed_s: elapsedShape.fanout_s ?? elapsedShape.facet_s,
    layers: layers.length,
    width_max: widths.length ? Math.max(...widths) : null,
    width_p50: pct(widths, 50),
    width_p95: pct(widths, 95),
    width_avg: widths.length ? +(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(2) : null,
    final_resolved: layers.length ? layers[layers.length - 1].resolved : null,
    final_seen: layers.length ? layers[layers.length - 1].seen : null,
    captured_lines: layers.length,
    probe_ok: r.ok,
  };
  allRows.push(row);
  fs.appendFileSync(WIDTHS_JSONL, JSON.stringify(row) + '\n');
  console.log(`[DONE] ${t.name}: path=${resolverPath} layers=${row.layers} max=${row.width_max} resolver_s=${row.resolver_elapsed_s} elapsed=${(elapsed / 1000).toFixed(1)}s`);
}

// Aggregate
const allWidths = [];
let totalLayers = 0;
for (const row of allRows) {
  const log = fs.readFileSync(path.join(PER_DIR, `${row.name}.log`), 'utf8');
  const lastResolveStart = log.lastIndexOf('Resolving ');
  const sliced = lastResolveStart > 0 ? log.slice(lastResolveStart) : log;
  for (const l of parseWidths(sliced)) {
    allWidths.push(l.width);
    totalLayers++;
  }
}
const overallMax = allWidths.length ? Math.max(...allWidths) : null;
const overallP50 = pct(allWidths, 50);
const overallP95 = pct(allWidths, 95);
const overallAvg = allWidths.length ? +(allWidths.reduce((a, b) => a + b, 0) / allWidths.length).toFixed(2) : null;

const okCount = allRows.filter((r) => r.path === 'fanout' && r.layers > 0).length;
const totalResolverS = allRows.reduce((acc, r) => acc + (r.resolver_elapsed_s ?? 0), 0);

let md = '# F-2 Resolver Fan-Out — Layer Width + Wall-Time Profile\n\n';
md += `Captured: ${new Date().toISOString()}\n`;
md += `BASE: ${process.env.BASE}\n`;
md += `Cohort size: ${targets.length} packages\n`;
md += `Path: fanout (frontier-coordinator) ran on ${okCount}/${allRows.length} packages\n`;
md += `Total resolver-BFS layers observed: ${totalLayers}\n`;
md += `Total resolver wall time: ${totalResolverS.toFixed(2)}s\n\n`;
md += '## Per-package\n\n';
md += '| Package | Path | Layers | Max width | p95 width | Avg width | Resolver wall (s) | npm install wall (s) |\n';
md += '|---------|------|--------|-----------|-----------|-----------|-------------------|----------------------|\n';
for (const r of allRows) {
  md += `| ${r.pkg} | ${r.path} | ${r.layers} | ${r.width_max ?? 'n/a'} | ${r.width_p95 ?? 'n/a'} | ${r.width_avg ?? 'n/a'} | ${r.resolver_elapsed_s ?? 'n/a'} | ${(r.elapsed_ms / 1000).toFixed(1)} |\n`;
}
md += '\n## Aggregate\n\n';
md += `- Max width across cohort: ${overallMax}\n`;
md += `- p95 width: ${overallP95}\n`;
md += `- Median width: ${overallP50}\n`;
md += `- Mean width: ${overallAvg}\n\n`;
md += '## Routing breakdown (NimbusFanoutPool auto-route)\n\n';
const IN_DO_THRESHOLD = 5;
let inDoLayers = 0, peerDoLayers = 0;
for (const w of allWidths) {
  if (w < IN_DO_THRESHOLD) inDoLayers++;
  else peerDoLayers++;
}
md += `- in-DO (POC C, width<${IN_DO_THRESHOLD}): ${inDoLayers} layers\n`;
md += `- peer-DO (POC B, width≥${IN_DO_THRESHOLD}): ${peerDoLayers} layers\n\n`;
fs.writeFileSync(SUMMARY_MD, md);
console.log('\n' + md);
console.log(`\nWrote ${SUMMARY_MD}`);

// Acceptance: at least one package's resolver path is "fanout" with layers > 0.
if (okCount === 0) {
  console.log('FAIL: no fanout-path resolver runs captured');
  process.exit(1);
}
