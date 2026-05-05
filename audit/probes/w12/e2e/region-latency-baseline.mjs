#!/usr/bin/env bun
// W12 e2e (prod-gated): document pre-W12 baseline cross-region latency.
//
// SKIPs cleanly without NIMBUS_W12_E2E=1.
//
// Real cross-region simulation requires CF colos, which we can't drive
// from this autonomous wave runner. As a best-effort substitute we
// record a *measurement protocol* — what to run when a human (or CT1
// drift detector) has prod credentials — and emit a baseline JSON
// stating "not measurable from this environment". The post-deploy
// e2e (region-latency-after.mjs) will record real numbers; the diff
// is the W12 lift.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'baseline.json');

if (process.env.NIMBUS_W12_E2E !== '1') {
  console.log('# SKIP w12/e2e/region-latency-baseline (NIMBUS_W12_E2E not set)');
  process.exit(0);
}

const BASE = process.env.NIMBUS_BASE || 'https://nimbus.ashishkmr472.workers.dev';
const SAMPLES = Number(process.env.NIMBUS_W12_SAMPLES || 20);

async function timeOne(url, headers) {
  const t0 = Date.now();
  const r = await fetch(url, { headers });
  const ms = Date.now() - t0;
  return { ms, status: r.status, ok: r.ok };
}

async function histogram(label, url, headers) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    try { samples.push(await timeOne(url, headers)); }
    catch (e) { samples.push({ ms: -1, status: 0, ok: false, error: String(e.message || e) }); }
  }
  const ok = samples.filter(s => s.ok).map(s => s.ms).sort((a, b) => a - b);
  const p = (q) => ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * q))] : null;
  const stat = {
    label, url,
    n: samples.length, oks: ok.length,
    p50: p(0.5), p90: p(0.9), p99: p(0.99),
    min: ok[0] ?? null, max: ok.at(-1) ?? null,
  };
  console.log('  ', label, JSON.stringify(stat));
  return stat;
}

const stats = [];
// We can't actually test cross-region from here, but we can probe the
// PUBLIC URL which embeds whatever colo we're in. Operators run this
// from EU/APAC laptops; CT1 may drive it from prod-VM colocations.
console.log('# region-latency-baseline against', BASE);
const sessionId = `latency-${Date.now()}`;
// Spawn a session so /preview/ has a target.
try {
  const new_ = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = new_.headers.get('Location') || '';
  console.log('# new session location:', loc);
} catch (e) {
  console.warn('# /new failed (continuing):', e?.message);
}

stats.push(await histogram('api-memory', `${BASE}/s/${sessionId}/api/memory`));
stats.push(await histogram('api-stats', `${BASE}/s/${sessionId}/api/stats`));
stats.push(await histogram('api-diag-memory', `${BASE}/s/${sessionId}/api/_diag/memory`));
stats.push(await histogram('preview', `${BASE}/s/${sessionId}/preview/`));

const baseline = {
  ts: new Date().toISOString(),
  base: BASE,
  origin: process.env.NIMBUS_W12_ORIGIN || 'unknown',
  samples_per_route: SAMPLES,
  routes: stats,
  note: 'baseline captured pre-W12 deploy. Diff against region-latency-after.json post-deploy.',
};
fs.writeFileSync(OUT, JSON.stringify(baseline, null, 2));
console.log('# wrote', OUT);
process.exit(0);
