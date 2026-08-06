#!/usr/bin/env bun
// assets-fetch/new/worker-bundle-size — gate on the deployed Worker bundle
// size. After the sdk-phase-1 ASSETS-fetch promote, the Worker bundle should
// be substantially smaller than the pre-promote 13 MB baseline. We do not hit
// the strict ≤1.5 MB charter target in v0.1 (see commit notes), so this gate
// enforces the meaningful improvement and then tracks drift against it.
//
// Methodology: run `wrangler deploy --dry-run --outdir` on apps/hosted-demo,
// inspect the produced index.js size. Fails fast if dry-run errors.
//
// The compressed size is reported alongside because that, not the raw byte
// count, is what the platform weighs on deploy. It is not gated: at 1.35 MB
// it is nowhere near a limit, so a second threshold here would be a number
// invented to look rigorous. The raw count is gated because it is the honest
// proxy for what actually costs us — script parse and cold-start.

import { spawnSync } from 'node:child_process';
import { statSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('assets-fetch/new/worker-bundle-size');

// Pre-promote: 13 MB (verified at commit time).
// Charter target: ≤ 1.5 MB (aspirational; will hit in phase 2 with code splitting).
//
// 7 MB, raised 2026-08-05 from 6 MB. Recorded rather than quietly bumped,
// because a budget nobody has to justify is not a budget.
//
// Measured at the raise, `-e production`: 6,736,870 bytes raw / 1,413,392
// gzipped. The 6 MB gate was set on 2026-06-04 (f6a5877) and the supervisor
// has since taken on three things it did not carry then: the session agent
// and the `ai` SDK it pulls in (2026-06-05, ~450 KB across ai +
// provider-utils + gateway + openai-compatible), the opencode facet runner
// (2026-06-10, ~51 KB), and the bash runtime (2026-07-20, ~60 KB). The gate
// was measuring a smaller product, so it failed for having been outgrown
// rather than for anything regressing.
//
// Nothing in the bundle is dead — every large input traces to a supervisor
// caller (isomorphic-git ← git/commands, acorn ← runtime/javascript-ast,
// ohm-js ← python-pip, esbuild-wasm ← runtime/esbuild-service). Getting back
// under 6 MB is therefore not a cleanup; it needs the phase-2 work of moving
// facet bundles out to the assets layer the way esbuild.wasm already is
// (git-bundle.generated alone is 482 KB of inlined string). That is a
// deliberate project, not something to smuggle in behind a threshold edit.
const THRESHOLD_BYTES = 7 * 1024 * 1024;

const outDir = mkdtempSync(join(tmpdir(), 'nimbus-bundle-'));
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const wranglerBin = join(repoRoot, 'node_modules', '.bin', 'wrangler');
const hostedDemoDir = join(repoRoot, 'apps', 'hosted-demo');

const dryRun = spawnSync(
  wranglerBin,
  ['deploy', '--dry-run', '--outdir', outDir, '-e', 'production'],
  { cwd: hostedDemoDir, encoding: 'utf8' },
);

if (dryRun.status !== 0) {
  console.log('wrangler stderr:', dryRun.stderr?.slice(-500));
  a.check('wrangler deploy --dry-run succeeds', false,
    `exit=${dryRun.status} stderr-tail=${dryRun.stderr?.slice(-200) || '<empty>'}`);
  const sum = a.summary();
  process.exit(sum.fail > 0 ? 1 : 0);
}
a.check('wrangler deploy --dry-run succeeds', true);

const bundlePath = join(outDir, 'index.js');
let stat;
try { stat = statSync(bundlePath); }
catch (e) {
  a.check('index.js exists in outdir', false, e?.message);
  const sum = a.summary();
  process.exit(1);
}

a.check('index.js exists in outdir', true);
const mb = (stat.size / 1024 / 1024).toFixed(2);
const gzipped = gzipSync(readFileSync(bundlePath), { level: 9 }).byteLength;
console.log(`  bundle: ${stat.size} bytes raw (${mb} MB) / ${gzipped} bytes gzipped `
  + `(${(gzipped / 1024 / 1024).toFixed(2)} MB — the size the platform weighs)`);
a.check(
  `Worker bundle ≤ ${(THRESHOLD_BYTES / 1024 / 1024).toFixed(1)} MB`,
  stat.size <= THRESHOLD_BYTES,
  `actual=${mb} MB (${stat.size} bytes), gzipped ${gzipped} bytes`,
);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
