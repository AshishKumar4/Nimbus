#!/usr/bin/env bun
// assets-fetch/new/worker-bundle-size — gate on the deployed Worker bundle
// size. After the sdk-phase-1 ASSETS-fetch promote, the Worker bundle should
// be substantially smaller than the pre-promote 13 MB baseline. We do not
// hit the strict ≤1.5 MB charter target in v0.1 (see commit notes), so this
// gate enforces the meaningful improvement: ≤ 6 MB.
//
// Methodology: run `wrangler deploy --dry-run --outdir` on apps/dogfood,
// inspect the produced index.js size. Fails fast if dry-run errors.

import { spawnSync } from 'node:child_process';
import { statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAsserter } from '../../_driver.mjs';

const a = makeAsserter('assets-fetch/new/worker-bundle-size');

// Hard threshold per sdk-phase-1 wave: post-promote ≤ 6 MB Worker bundle.
// Pre-promote: 13 MB (verified at commit time).
// Charter target: ≤ 1.5 MB (aspirational; will hit in phase 2 with code splitting).
const THRESHOLD_BYTES = 6 * 1024 * 1024;

const outDir = mkdtempSync(join(tmpdir(), 'nimbus-bundle-'));
const repoRoot = new URL('../../../../', import.meta.url).pathname;
const wranglerBin = join(repoRoot, 'node_modules', '.bin', 'wrangler');
const dogfoodDir = join(repoRoot, 'apps', 'dogfood');

const dryRun = spawnSync(
  wranglerBin,
  ['deploy', '--dry-run', '--outdir', outDir, '-e', 'production'],
  { cwd: dogfoodDir, encoding: 'utf8' },
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
a.check(
  `Worker bundle ≤ ${(THRESHOLD_BYTES / 1024 / 1024).toFixed(1)} MB`,
  stat.size <= THRESHOLD_BYTES,
  `actual=${mb} MB (${stat.size} bytes)`,
);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
