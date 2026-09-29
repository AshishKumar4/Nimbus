#!/usr/bin/env bun
// assets-fetch/new/worker-bundle-size — the hosted Worker (production env)
// fits the platform's two script limits, measured the way the platform
// documents measuring them
// (https://developers.cloudflare.com/workers/platform/limits/):
//
//   Worker size: 64 MiB uncompressed, every module counted (JS and wasm),
//   no compressed limit. `wrangler deploy --dry-run` reports it as
//   `Total Upload`.
//
//   Startup: the global scope of every module must parse and run within
//   1 second, or the deploy is rejected (error 10021). `wrangler check
//   startup` profiles it on local workerd; the platform's own number is the
//   `startup_time_ms` a real deploy reports, which differs by CPU.
//
// This replaces a 7 MB gate on index.js alone. That number was a budget
// Nimbus set itself when compressed size was limited; the host now bundles
// the wasm it hands to Loader guests compiled (worker/src/runtime/
// host-wasm.ts), which is both counted in the upload and compiled at
// startup, so these two limits are what bound it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('assets-fetch/new/worker-bundle-size');

/** https://developers.cloudflare.com/workers/platform/limits/#worker-size */
const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time */
const STARTUP_LIMIT_MS = 1000;

const outDir = mkdtempSync(join(tmpdir(), 'nimbus-bundle-'));
// Every way out of this probe is process.exit: the hook removes the dry-run output on each.
process.on('exit', () => rmSync(outDir, { recursive: true, force: true }));
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const wranglerBin = join(repoRoot, 'node_modules', '.bin', 'wrangler');
const hostedDemoDir = join(repoRoot, 'apps', 'hosted-demo');

function finish() {
  const sum = a.summary();
  process.exit(sum.fail > 0 ? 1 : 0);
}

function wrangler(args) {
  return spawnSync(wranglerBin, args, { cwd: hostedDemoDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

// ── size ─────────────────────────────────────────────────────────────
const dryRun = wrangler(['deploy', '--dry-run', '--outdir', join(outDir, 'bundle'), '-e', 'production']);
a.check('wrangler deploy --dry-run succeeds', dryRun.status === 0,
  `exit=${dryRun.status} stderr-tail=${dryRun.stderr?.slice(-300) || '<empty>'}`);
if (dryRun.status !== 0) finish();

// "Total Upload: 18859.45 KiB / gzip: 4694.87 KiB"
const upload = /Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/.exec(`${dryRun.stdout}\n${dryRun.stderr}`);
a.check('wrangler reports the Total Upload', upload !== null, (dryRun.stdout || '').slice(-400));
if (!upload) finish();
const uploadBytes = Math.round(Number(upload[1]) * 1024);
console.log(`  Total Upload: ${upload[1]} KiB (${(uploadBytes / 1024 / 1024).toFixed(2)} MiB), gzip ${upload[2]} KiB (not limited)`);
a.check(
  'Worker size within the 64 MiB uncompressed limit',
  uploadBytes <= WORKER_SIZE_LIMIT_BYTES,
  `${uploadBytes} bytes of ${WORKER_SIZE_LIMIT_BYTES}`,
);

// ── startup ──────────────────────────────────────────────────────────
const profilePath = join(outDir, 'startup.cpuprofile');
const check = wrangler(['check', 'startup', '-e', 'production', '--outfile', profilePath]);
a.check('wrangler check startup succeeds', check.status === 0,
  `exit=${check.status} stderr-tail=${check.stderr?.slice(-300) || '<empty>'}`);
if (check.status !== 0) finish();

// Active startup CPU: every sampled interval not spent idle, as wrangler's
// own "Active" line counts it (garbage collection included).
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
let activeMicros = 0;
for (let i = 0; i < profile.samples.length; i++) {
  if (!idle.has(profile.samples[i])) activeMicros += profile.timeDeltas[i] ?? 0;
}
const activeMs = activeMicros / 1000;
console.log(`  startup: ${activeMs.toFixed(1)} ms active CPU on local workerd `
  + `(profile window ${((profile.endTime - profile.startTime) / 1000).toFixed(1)} ms)`);
a.check(
  'startup within the 1 s limit (local profile)',
  activeMs < STARTUP_LIMIT_MS,
  `${activeMs.toFixed(1)} ms active`,
);

finish();
