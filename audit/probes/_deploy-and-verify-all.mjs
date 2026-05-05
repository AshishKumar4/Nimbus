#!/usr/bin/env bun
/**
 * Nimbus post-deploy verification orchestrator.
 *
 * What this does, in order:
 *   1. Verifies wrangler is authenticated (`wrangler whoami`).
 *   2. Captures W12 baseline latency from EU + APAC (BEFORE deploy).
 *   3. Deploys current main with `CLOUDFLARE_ACCOUNT_ID=f44999d1ddda7012e9a87729eba250f1`.
 *   4. Captures the new Worker Version ID from the deploy output.
 *   5. Sleeps 15+ minutes for Smart Placement convergence (W12 acceptance gate).
 *      Override with NIMBUS_DEPLOY_VERIFY_WAIT_SEC=<n> for fast iteration; the
 *      W12 acceptance probes will report whether Smart Placement converged.
 *   6. Runs every wave's prod-gated probes:
 *      - W3 builtin completeness + crypto correctness
 *      - W4 Mossaic cold-warm + cache hit ratio
 *      - W5 OOM stress (50 parallel installs)
 *      - W6 WASM swap registry coverage
 *      - W7 streams over RPC (5GB monorepo + heap-peak)
 *      - W8 child_process facet-mapped (husky/concurrently/etc)
 *      - W9 hibernation cycle (24-48 h CT1 baseline gate, only structural assertion here)
 *      - W10 wrangler-dev e2e (starter-worker-router + starter-d1 + RpcTarget shape)
 *      - W11 framework starters (SK/Astro/Remix/Nuxt/Next)
 *      - W12 multi-region latency (EU + APAC p99 < 500ms)
 *   7. Writes `audit/sections/POST-DEPLOY-VERIFICATION.md` with pass/fail per wave.
 *   8. Commits + pushes the verification report.
 *
 * NOTHING in this script attempts wrangler login on the user's behalf.
 * If `wrangler whoami` fails, the script exits non-zero and prints the
 * one-line OAuth instruction.
 *
 * Run from repo root:  bun audit/probes/_deploy-and-verify-all.mjs
 *
 * Flags:
 *   --skip-deploy       Reuse the currently-deployed Worker; only run probes.
 *   --skip-baseline     Skip W12 pre-deploy baseline capture.
 *   --skip-wait         Skip the Smart Placement 15-min wait (use for re-runs).
 *   --skip-commit       Don't auto-commit/push the verification report.
 *   --only=W3,W12       Only run the listed waves' probes.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID  defaults to f44999d1ddda7012e9a87729eba250f1
 *   NIMBUS_DEPLOY_VERIFY_WAIT_SEC  override 900 sec wait
 *   NIMBUS_BASE_URL        prod URL probes target (default https://nimbus.ashishkmr472.workers.dev)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// ---------- arg parsing ----------
const ARGS = new Set(process.argv.slice(2));
const SKIP_DEPLOY = ARGS.has('--skip-deploy');
const SKIP_BASELINE = ARGS.has('--skip-baseline');
const SKIP_WAIT = ARGS.has('--skip-wait');
const SKIP_COMMIT = ARGS.has('--skip-commit');
const ONLY_FLAG = [...ARGS].find((a) => a.startsWith('--only='));
const ONLY_WAVES = ONLY_FLAG ? new Set(ONLY_FLAG.slice('--only='.length).split(',').map((s) => s.trim().toUpperCase())) : null;

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'f44999d1ddda7012e9a87729eba250f1';
const WAIT_SEC = Number(process.env.NIMBUS_DEPLOY_VERIFY_WAIT_SEC ?? 900);
const BASE_URL = process.env.NIMBUS_BASE_URL || 'https://nimbus.ashishkmr472.workers.dev';

// ---------- helpers ----------
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: opts.capture ? 'pipe' : 'inherit',
    cwd: opts.cwd || REPO,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
  });
  return r;
}

function wrangler(args, opts = {}) {
  const bin = path.join(REPO, 'node_modules', '.bin', 'wrangler');
  if (!fs.existsSync(bin)) return run('npx', ['wrangler', ...args], opts);
  return run(bin, args, opts);
}

function shouldRunWave(wave) {
  if (!ONLY_WAVES) return true;
  return ONLY_WAVES.has(wave.toUpperCase());
}

function nowIso() {
  return new Date().toISOString();
}

// Each wave entry: { wave, label, env, args, probe }
// `probe` is a path relative to REPO. `args` is bun args after the script.
const WAVE_PROBES = [
  {
    wave: 'W3',
    label: 'Builtin completeness + crypto correctness',
    probe: 'audit/probes/w3/run-all.mjs',
    env: { BASE_URL },
    args: [],
  },
  {
    wave: 'W4',
    label: 'npm install UX (R2 cache, pipelining)',
    probe: 'audit/probes/w4/run-all.mjs',
    env: { BASE_URL },
    args: ['--full', '--phase=prod-verify'],
  },
  {
    wave: 'W5',
    label: 'Robustness (OOM observability)',
    probe: 'audit/probes/w5/run-all.mjs',
    env: { NIMBUS_W5_E2E_PROD: '1', BASE_URL },
    args: [],
  },
  {
    wave: 'W6',
    label: 'WASM swap registry + REJECT_INSTALL',
    probe: 'audit/probes/w6/run-all.mjs',
    env: { NIMBUS_W6_E2E_PROD: '1', BASE_URL },
    args: [],
  },
  {
    wave: 'W7',
    label: 'Streams over RPC (32 MiB wall bypass + heap-peak)',
    probe: 'audit/probes/w7/run-all.mjs',
    env: { BASE_URL },
    args: [],
  },
  {
    wave: 'W8',
    label: 'child_process.spawn (facet-mapped)',
    probe: 'audit/probes/w8/run-all.mjs',
    env: { BASE_URL },
    args: [],
  },
  {
    wave: 'W9',
    label: 'Hibernatable process logs + WS auto-response',
    probe: 'audit/probes/w9/run-all.mjs',
    env: { NIMBUS_W9_E2E: '1', BASE_URL },
    args: [],
  },
  {
    wave: 'W10',
    label: 'wrangler dev / CF Workers projects (RpcTarget HIGH-risk)',
    probe: 'audit/probes/w10/run-all.mjs',
    env: { NIMBUS_W10_E2E_PROD: '1', BASE_URL },
    args: [],
  },
  {
    wave: 'W11',
    label: 'Framework starters (SK/Astro/Remix/Nuxt/Next)',
    probe: 'audit/probes/w11/run-all.mjs',
    env: { NIMBUS_W11_E2E: '1', BASE_URL },
    args: [],
  },
  // W12 is special: needs the EU + APAC origin variants and the post-deploy timing.
  {
    wave: 'W12-EU',
    label: 'Multi-region latency from EU origin',
    probe: 'audit/probes/w12/e2e/region-latency-after.mjs',
    env: { NIMBUS_W12_E2E: '1', NIMBUS_W12_ORIGIN: 'EU', BASE_URL },
    args: [],
  },
  {
    wave: 'W12-APAC',
    label: 'Multi-region latency from APAC origin',
    probe: 'audit/probes/w12/e2e/region-latency-after.mjs',
    env: { NIMBUS_W12_E2E: '1', NIMBUS_W12_ORIGIN: 'APAC', BASE_URL },
    args: [],
  },
  {
    wave: 'W12-MOSSAIC',
    label: 'W12 Mossaic regression e2e',
    probe: 'audit/probes/w12/e2e/mossaic-regression-e2e.mjs',
    env: { NIMBUS_W12_E2E: '1', BASE_URL },
    args: [],
  },
];

// ---------- step 1: wrangler whoami ----------
console.log('# Step 1: wrangler whoami');
{
  const r = wrangler(['whoami'], { capture: true });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  // wrangler returns exit 0 even for unauthenticated state and emits "not authenticated"
  // to stdout. Detect both signals.
  const txt = (r.stdout || '') + '\n' + (r.stderr || '');
  const unauth = /not authenticated/i.test(txt) || /Please run `wrangler login`/i.test(txt);
  if (r.status !== 0 || unauth) {
    console.error('\n[FATAL] wrangler is not authenticated. Run:');
    console.error('  ./node_modules/.bin/wrangler login --browser=false');
    console.error('then re-run this script.');
    process.exit(2);
  }
}

// ---------- step 2: W12 baseline (BEFORE deploy) ----------
const baseline = { eu: null, apac: null };
if (!SKIP_BASELINE && !SKIP_DEPLOY) {
  console.log('\n# Step 2: W12 region-latency baseline (pre-deploy)');
  for (const region of ['EU', 'APAC']) {
    const r = run('bun', ['audit/probes/w12/e2e/region-latency-baseline.mjs'], {
      capture: true,
      env: { NIMBUS_W12_E2E: '1', NIMBUS_W12_ORIGIN: region, BASE_URL },
    });
    process.stdout.write(r.stdout || '');
    process.stderr.write(r.stderr || '');
    baseline[region.toLowerCase()] = { ok: r.status === 0, exit: r.status };
  }
} else {
  console.log('\n# Step 2: SKIP W12 baseline (--skip-baseline or --skip-deploy)');
}

// ---------- step 3 + 4: deploy + capture Version ID ----------
let versionId = null;
let deployOk = false;
if (!SKIP_DEPLOY) {
  console.log('\n# Step 3: wrangler deploy');
  const r = wrangler(['deploy'], {
    capture: true,
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  deployOk = r.status === 0;

  // Try to extract a Version ID from stdout. Wrangler output formats vary; cover common patterns.
  const text = (r.stdout || '') + '\n' + (r.stderr || '');
  const m =
    text.match(/Current Version ID:\s*([0-9a-f-]{8,})/i) ||
    text.match(/Version ID:\s*([0-9a-f-]{8,})/i) ||
    text.match(/Worker Version ID:\s*([0-9a-f-]{8,})/i) ||
    text.match(/Deployment ID:\s*([0-9a-f-]{8,})/i);
  versionId = m ? m[1] : null;
  console.log(`\n# captured versionId=${versionId ?? '(none parsed)'}  deployOk=${deployOk}`);

  if (!deployOk) {
    console.error('\n[WARN] wrangler deploy failed. If the failure mentions `replica_routing`,');
    console.error('comment out that line in wrangler.jsonc and re-run with --skip-baseline.');
    console.error('Continuing to probes anyway against the previously-deployed Worker...');
  }
} else {
  console.log('\n# Step 3: SKIP deploy (--skip-deploy)');
}

// ---------- step 5: Smart Placement wait ----------
if (!SKIP_DEPLOY && !SKIP_WAIT && deployOk) {
  console.log(`\n# Step 5: waiting ${WAIT_SEC}s for Smart Placement convergence (W12)`);
  // Sleep in 30s chunks so the progress is visible.
  const chunk = 30;
  let remaining = WAIT_SEC;
  while (remaining > 0) {
    const dt = Math.min(chunk, remaining);
    await new Promise((res) => setTimeout(res, dt * 1000));
    remaining -= dt;
    if (remaining > 0) console.log(`  ... ${remaining}s remaining`);
  }
  console.log('# convergence wait done');
} else {
  console.log('\n# Step 5: SKIP Smart Placement wait');
}

// ---------- step 6: run every wave's prod-gated probes ----------
console.log('\n# Step 6: prod-gated wave probes');
const results = [];
for (const w of WAVE_PROBES) {
  const waveTop = w.wave.split('-')[0]; // W12-EU -> W12 for --only matching
  if (!shouldRunWave(waveTop)) {
    console.log(`\n# SKIP ${w.wave} (--only filter)`);
    results.push({ wave: w.wave, label: w.label, status: 'skipped', exit: null, ms: 0 });
    continue;
  }
  console.log(`\n========================================`);
  console.log(`# ${w.wave}: ${w.label}`);
  console.log(`# probe: ${w.probe}`);
  console.log(`========================================`);
  const t0 = Date.now();
  const r = run('bun', [w.probe, ...w.args], { env: w.env });
  const ms = Date.now() - t0;
  results.push({
    wave: w.wave,
    label: w.label,
    probe: w.probe,
    status: r.status === 0 ? 'pass' : 'fail',
    exit: r.status,
    ms,
  });
}

// ---------- step 7: write report ----------
const reportPath = path.join(REPO, 'audit', 'sections', 'POST-DEPLOY-VERIFICATION.md');
const lines = [];
lines.push('# Post-Deploy Verification Report');
lines.push('');
lines.push(`> **Generated:** ${nowIso()}`);
lines.push(`> **Account ID:** ${ACCOUNT_ID}`);
lines.push(`> **Worker Version ID:** ${versionId ?? '(unparsed; check wrangler deployments output)'}`);
lines.push(`> **Base URL:** ${BASE_URL}`);
lines.push(`> **Deploy:** ${SKIP_DEPLOY ? 'SKIPPED (--skip-deploy)' : (deployOk ? 'OK' : 'FAILED — see stderr')}`);
lines.push(`> **Smart Placement wait:** ${SKIP_WAIT || SKIP_DEPLOY ? 'SKIPPED' : `${WAIT_SEC}s`}`);
lines.push('');
lines.push('## Wave-by-wave results');
lines.push('');
lines.push('| Wave | Status | Exit | Duration | Probe | Notes |');
lines.push('|---|---|---|---|---|---|');
for (const r of results) {
  const flag = r.status === 'pass' ? '✓ PASS' : r.status === 'fail' ? '✗ FAIL' : '— skipped';
  lines.push(`| ${r.wave} | ${flag} | ${r.exit ?? '-'} | ${r.ms} ms | \`${r.probe ?? '-'}\` | ${r.label} |`);
}
lines.push('');
lines.push('## Pre-deploy W12 baseline');
lines.push('');
lines.push('| Region | Baseline status |');
lines.push('|---|---|');
lines.push(`| EU   | ${baseline.eu ? (baseline.eu.ok ? 'captured' : `failed (exit ${baseline.eu.exit})`) : 'skipped'} |`);
lines.push(`| APAC | ${baseline.apac ? (baseline.apac.ok ? 'captured' : `failed (exit ${baseline.apac.exit})`) : 'skipped'} |`);
lines.push('');
lines.push('## Next actions');
lines.push('');
const fails = results.filter((r) => r.status === 'fail');
if (fails.length === 0 && deployOk) {
  lines.push('All gates GREEN. Update `MASTER-ROADMAP.md` "Pending Prod Deploys" table:');
  lines.push('replace each "Pending" entry with `Verified on prod ' + nowIso() + '`.');
} else {
  lines.push('Failed gates and follow-up:');
  lines.push('');
  for (const r of fails) {
    lines.push(`- **${r.wave}** (${r.label}) → see corresponding \`W${r.wave.replace(/-.*$/, '').slice(1)}-retro.md §6\` for the W*.5 follow-up trigger.`);
  }
  if (!deployOk && !SKIP_DEPLOY) {
    lines.push('- **Deploy itself failed.** Most likely cause: `replica_routing` compat flag (W12) rejected by the runtime allowlist. Comment out the flag in `wrangler.jsonc` and rerun.');
  }
}
lines.push('');
lines.push('---');
lines.push('');
lines.push('Generated by `audit/probes/_deploy-and-verify-all.mjs`.');

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`\n# Wrote ${reportPath}`);

// ---------- step 8: commit + push ----------
if (!SKIP_COMMIT) {
  console.log('\n# Step 8: commit + push verification report');
  run('git', ['add', 'audit/sections/POST-DEPLOY-VERIFICATION.md']);
  const commitMsg = `audit: POST-DEPLOY-VERIFICATION — ${nowIso()} (${fails.length} failed, ${results.filter((r) => r.status === 'pass').length} passed)`;
  const c = run('git', ['commit', '-m', commitMsg], { capture: true });
  if (c.status === 0) {
    run('git', ['push', 'origin', 'main']);
  } else {
    // Empty commit (e.g. nothing to commit) — that's fine.
    process.stdout.write(c.stdout || '');
    process.stderr.write(c.stderr || '');
    console.log('# (no commit created — likely no changes)');
  }
} else {
  console.log('\n# Step 8: SKIP commit (--skip-commit)');
}

// ---------- exit code ----------
const overallFail = results.some((r) => r.status === 'fail') || (!SKIP_DEPLOY && !deployOk);
console.log(`\n# Done. overallFail=${overallFail}. report=${reportPath}`);
process.exit(overallFail ? 1 : 0);
