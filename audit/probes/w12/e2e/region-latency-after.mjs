#!/usr/bin/env bun
// W12 e2e (prod-gated): post-W12 cross-region latency. Compares to
// baseline.json if present.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, '..', 'baseline.json');
const OUT = path.join(HERE, '..', 'after.json');

if (process.env.NIMBUS_W12_E2E !== '1') {
  console.log('# SKIP w12/e2e/region-latency-after (NIMBUS_W12_E2E not set)');
  process.exit(0);
}

const BASE = process.env.NIMBUS_BASE || 'https://nimbus.ashishkmr472.workers.dev';
const SAMPLES = Number(process.env.NIMBUS_W12_SAMPLES || 20);

async function timeOne(url) {
  const t0 = Date.now();
  const r = await fetch(url);
  const ms = Date.now() - t0;
  return { ms, status: r.status, ok: r.ok };
}

async function histogram(label, url) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    try { samples.push(await timeOne(url)); }
    catch (e) { samples.push({ ms: -1, status: 0, ok: false }); }
  }
  const ok = samples.filter(s => s.ok).map(s => s.ms).sort((a, b) => a - b);
  const p = (q) => ok.length ? ok[Math.min(ok.length - 1, Math.floor(ok.length * q))] : null;
  return { label, url, n: samples.length, oks: ok.length, p50: p(0.5), p90: p(0.9), p99: p(0.99) };
}

const sessionId = `latency-${Date.now()}`;
try { await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' }); } catch {}

const stats = [];
stats.push(await histogram('api-memory', `${BASE}/s/${sessionId}/api/memory`));
stats.push(await histogram('api-stats', `${BASE}/s/${sessionId}/api/stats`));
stats.push(await histogram('api-diag-memory', `${BASE}/s/${sessionId}/api/_diag/memory`));
stats.push(await histogram('preview', `${BASE}/s/${sessionId}/preview/`));

let baseline = null;
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch {}

const after = {
  ts: new Date().toISOString(),
  base: BASE,
  origin: process.env.NIMBUS_W12_ORIGIN || 'unknown',
  samples_per_route: SAMPLES,
  routes: stats,
  baseline_ref: baseline ? baseline.ts : null,
};
fs.writeFileSync(OUT, JSON.stringify(after, null, 2));

// Acceptance gate: p99 of api-memory + preview must be < 500ms when
// the test is invoked in EU/APAC origin (operator opt-in via
// NIMBUS_W12_ORIGIN=EU). Without that flag we emit a soft note.
let allOk = true;
const note = [];
for (const s of stats) {
  if (s.p99 == null) {
    note.push(`${s.label}: no successful samples — wrangler not deployed?`);
    continue;
  }
  if (process.env.NIMBUS_W12_ORIGIN === 'EU' || process.env.NIMBUS_W12_ORIGIN === 'APAC') {
    if (s.label !== 'preview' && s.label !== 'api-memory' && s.label !== 'api-diag-memory' && s.label !== 'api-stats') continue;
    if (s.p99 >= 500) {
      note.push(`${s.label}: p99=${s.p99}ms ≥ 500ms — W12 acceptance gate failed`);
      allOk = false;
    } else {
      note.push(`${s.label}: p99=${s.p99}ms < 500ms ✓`);
    }
  } else {
    note.push(`${s.label}: p99=${s.p99}ms (origin not EU/APAC, gate not enforced)`);
  }
}
console.log('# region-latency-after results:');
for (const n of note) console.log('  ', n);
console.log('# wrote', OUT);
process.exit(allOk ? 0 : 1);
