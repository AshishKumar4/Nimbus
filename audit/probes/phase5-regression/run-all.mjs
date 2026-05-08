// Phase 5 P5.3 — full regression runner.
//
// Exercises every X.5 / W* / Track A'/B'/C'/D' functional probe
// that runs against local wrangler dev. Captures verdicts to
// run-all.txt. A single PASS line per probe; a final SUMMARY block.
//
// Probes that target prod (mossaic-prod-w2, packages-prod-*) are
// SKIPPED — they require workers.dev access. Phase 5 acceptance is
// "no cross-wave regression in local"; the prod-target probes run
// post-merge.
//
// Probes that need wrangler dev running on BASE (default
// http://127.0.0.1:8792). The runner does NOT spawn wrangler — it
// expects an external instance.
//
// Knobs (env):
//   BASE     wrangler url (default http://127.0.0.1:8792)
//   QUICK    if '1', skip slow probes (long-form-replay, etc.)
//
// Output:
//   audit/probes/phase5-regression/run-all.txt — per-probe PASS/FAIL
//   audit/probes/phase5-regression/run-all.jsonl — structured events
//
// Exit 0 = all GREEN. Exit 1 = any FAIL.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const TXT = path.join(HERE, 'run-all.txt');
const JSONL = path.join(HERE, 'run-all.jsonl');
fs.writeFileSync(TXT, '');
fs.writeFileSync(JSONL, '');
const log = (s) => { fs.appendFileSync(TXT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };
const event = (e) => fs.appendFileSync(JSONL, JSON.stringify(e) + '\n');

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const QUICK = process.env.QUICK === '1';

// Probe specs: { name, path-relative-to-ROOT, timeoutMs, tags[] }
// Phase 5 regression set — chosen to cover every major architectural
// surface from Phases 1-4 + the X.5 wave. Slow probes (>60s) are
// gated behind !QUICK.
const PROBES = [
  // ── Phase 1 / C' — observability ─────────────────────────────────
  { name: 'C\'.1 heap-estimator',
    file: 'audit/probes/c-prime/heap-estimator/heap-estimator.mjs',
    timeoutMs: 30_000, needsBase: true },
  { name: 'C\'.2 recovery-events',
    file: 'audit/probes/c-prime/recovery-events/recovery-events.mjs',
    timeoutMs: 30_000, needsBase: true },
  { name: 'C\'.3 error-recovery',
    file: 'audit/probes/interactive-liveness/error-recovery/error-recovery.mjs',
    timeoutMs: 30_000, needsBase: true },

  // ── Phase 2 / A' — heap reductions ───────────────────────────────
  { name: 'A\'.1 resolver-fallback',
    file: 'audit/probes/a-prime/a1-resolver-fallback/single-resolver-invariant.mjs',
    timeoutMs: 60_000, needsBase: true },
  { name: 'A\'.2 streaming-buffers',
    file: 'audit/probes/a-prime/a2-streaming-buffers/streaming-buffers.mjs',
    timeoutMs: 60_000, needsBase: true },
  { name: 'A\'.3 barrel-synth',
    file: 'audit/probes/a-prime/a3-barrel-synth/barrel-synth-bound.mjs',
    timeoutMs: 60_000, needsBase: true },
  { name: 'A\'.5 esbuild-bytes',
    file: 'audit/probes/a-prime/a5-esbuild-bytes/esbuild-bytes.mjs',
    timeoutMs: 30_000, needsBase: true },

  // ── Phase 3 / B' — recovery correctness ──────────────────────────
  { name: 'B\'.1 shell-state',
    file: 'audit/probes/b-prime/b1-shell-state/shell-state-survives-reconnect.mjs',
    timeoutMs: 60_000, needsBase: true },
  { name: 'B\'.2 kernel-mounts',
    file: 'audit/probes/b-prime/b2-kernel-mounts/kernel-mounts-persisted.mjs',
    timeoutMs: 30_000, needsBase: true },
  { name: 'B\'.3 scrollback',
    file: 'audit/probes/b-prime/b3-scrollback/scrollback-survives-reconnect.mjs',
    timeoutMs: 240_000, needsBase: true },
  { name: 'B\'.4 phase-machine',
    file: 'audit/probes/b-prime/b4-phase-machine/init-session-phases.mjs',
    timeoutMs: 60_000, needsBase: true },
  { name: 'B\'.5 join-existing',
    file: 'audit/probes/b-prime/b5-join-existing/join-existing-session.mjs',
    timeoutMs: 60_000, needsBase: true },

  // ── Phase 4 / D' — primitive alignment ───────────────────────────
  { name: 'D\'.1 cirrus-real-do-facet',
    file: 'audit/probes/d-prime/d1-cirrus-real-facet/cirrus-real-do-facet.mjs',
    timeoutMs: 90_000, needsBase: true },
  { name: 'D\'.2 loader-pool-rename',
    file: 'audit/probes/d-prime/d2-loader-pool-rename/loader-pool-rename.mjs',
    timeoutMs: 120_000, needsBase: false },

  // ── Phase 5 / interactive-liveness ───────────────────────────────
  // long-form-replay and multi-isolate-sweep are run separately for
  // P5.1 / P5.2; not re-run here to keep the regression fast.
  // walltime-distribution is the third interactive-liveness probe.
  { name: 'interactive-liveness/walltime-distribution',
    file: 'audit/probes/interactive-liveness/walltime-distribution/walltime-distribution.mjs',
    timeoutMs: 90_000, needsBase: true },

  // ── Wave functional sets ─────────────────────────────────────────
  { name: 'W5 ring-persistence',
    file: 'audit/probes/w5/functional/ring-persistence.mjs',
    timeoutMs: 60_000, needsBase: false },
  { name: 'W5 lru-shrink-restore',
    file: 'audit/probes/w5/functional/lru-shrink-restore.mjs',
    timeoutMs: 60_000, needsBase: false },
  { name: 'W5 sqlite-nomem-retry',
    file: 'audit/probes/w5/functional/sqlite-nomem-retry.mjs',
    timeoutMs: 60_000, needsBase: false },
  { name: 'W5 diag-shape',
    file: 'audit/probes/w5/functional/diag-shape.mjs',
    timeoutMs: 60_000, needsBase: false },

  // ── W7 streaming-buffer set (slow; QUICK-skipped) ────────────────
  { name: 'W7 frame-roundtrip',
    file: 'audit/probes/w7/functional/01-frame-roundtrip.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 large-payload',
    file: 'audit/probes/w7/functional/02-large-payload.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 backpressure',
    file: 'audit/probes/w7/functional/03-backpressure.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 cancel-mid-stream',
    file: 'audit/probes/w7/functional/04-cancel-mid-stream.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 error-propagation',
    file: 'audit/probes/w7/functional/05-error-propagation.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 empty-batches',
    file: 'audit/probes/w7/functional/06-empty-batches.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 bytes-source-type',
    file: 'audit/probes/w7/functional/07-bytes-source-type.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },
  { name: 'W7 writestream-on-vfs',
    file: 'audit/probes/w7/functional/08-writestream-on-vfs.mjs',
    timeoutMs: 60_000, needsBase: false, slow: true },

  // ── Refactor gate (tsc baseline + structural surface) ────────────
  { name: 'refactor-gate (tsc baseline + RPC + cmds + exports)',
    file: 'audit/probes/regression/_refactor-gate.mjs',
    timeoutMs: 90_000, needsBase: false },

  // ── Deploy validation (wrangler.jsonc has no $experimental flags) ─
  // Added 2026-05-08 after DEPLOY-FLAG-FIX. Pre-flight that prevents
  // a $experimental flag from sneaking back into wrangler.jsonc; the
  // platform-side validator rejects them at upload with [code: 10021].
  { name: 'deploy-validation/no-experimental-flags',
    file: 'audit/probes/deploy-validation/no-experimental-flags.mjs',
    timeoutMs: 30_000, needsBase: false },
];

const results = [];
const t0 = Date.now();

log('==== Phase 5 P5.3 — full regression run ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
log(`BASE: ${BASE}`);
log(`QUICK: ${QUICK}`);
log(`probes to run: ${PROBES.filter(p => !(QUICK && p.slow)).length} of ${PROBES.length} total`);
log('');

for (const p of PROBES) {
  if (QUICK && p.slow) {
    log(`SKIP   ${p.name} (slow)`);
    results.push({ name: p.name, status: 'SKIP', dur: 0 });
    continue;
  }

  const probePath = path.join(ROOT, p.file);
  if (!fs.existsSync(probePath)) {
    log(`MISS   ${p.name} (file not found: ${p.file})`);
    results.push({ name: p.name, status: 'MISS', dur: 0 });
    continue;
  }

  const tStart = Date.now();
  const env = { ...process.env, BASE };
  const r = spawnSync('bun', [probePath], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: p.timeoutMs,
  });
  const dur = Date.now() - tStart;
  const exitCode = r.status;
  const passLines = (r.stdout || '').split('\n').filter(l => /^PASS:/.test(l)).length;
  const failLines = (r.stdout || '').split('\n').filter(l => /^FAIL:/.test(l)).length;
  const status = exitCode === 0 ? 'PASS' : (exitCode === null ? 'TIMEOUT' : 'FAIL');
  results.push({ name: p.name, status, dur, exitCode, passLines, failLines });
  event({ t: Date.now(), kind: 'probe', name: p.name, status, dur, exitCode, passLines, failLines });
  log(`${status.padEnd(7)} ${p.name.padEnd(50)} ${(passLines + '/' + (passLines + failLines)).padStart(7)}  ${(dur + 'ms').padStart(7)}`);
  if (status !== 'PASS') {
    // Surface first 20 lines of stdout/stderr for debugging.
    const lines = ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-25);
    for (const l of lines) log('  ' + l);
  }
}

// ── Summary ──────────────────────────────────────────────────────────
const totalDur = Date.now() - t0;
const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, SKIP: 0, MISS: 0 };
for (const r of results) counts[r.status]++;
log('');
log('==== SUMMARY ====');
log(`total runtime: ${(totalDur / 1000).toFixed(1)}s`);
for (const k of Object.keys(counts)) {
  log(`  ${k.padEnd(8)}: ${counts[k]}`);
}
const totalPassLines = results.reduce((s, r) => s + (r.passLines || 0), 0);
const totalFailLines = results.reduce((s, r) => s + (r.failLines || 0), 0);
log(`  total PASS lines: ${totalPassLines}`);
log(`  total FAIL lines: ${totalFailLines}`);

const exitCode = (counts.FAIL + counts.TIMEOUT + counts.MISS) === 0 ? 0 : 1;
log(`==== EXIT ${exitCode} ====`);
process.exit(exitCode);
