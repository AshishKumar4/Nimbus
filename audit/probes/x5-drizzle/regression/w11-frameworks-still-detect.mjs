#!/usr/bin/env bun
// X.5-drizzle regression: run each of W11's 5 detect-*.mjs functional
// probes (next/astro/nuxt/remix/sveltekit) + the wrangler-on-framework
// probe. PASSES iff all still exit 0. Direct anti-regression guard for
// the W11 framework-detect contract.
//
// Critical anti-requirement: x5-drizzle MUST NOT regress W11
// framework detection. This probe is the gate.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const W11_PROBES = [
  'audit/probes/w11/functional/detect-next.mjs',
  'audit/probes/w11/functional/detect-astro.mjs',
  'audit/probes/w11/functional/detect-nuxt.mjs',
  'audit/probes/w11/functional/detect-remix.mjs',
  'audit/probes/w11/functional/detect-sveltekit.mjs',
  'audit/probes/w11/functional/detect-wrangler.mjs',
  'audit/probes/w11/functional/detect-wrangler-on-framework.mjs',
  'audit/probes/w11/functional/detect-vite-generic.mjs',
  'audit/probes/w11/functional/detect-precedence.mjs',
  'audit/probes/w11/functional/detect-remix-bare-react.mjs',
  'audit/probes/w11/functional/detect-unknown.mjs',
  'audit/probes/w11/functional/shim-modules-loadable.mjs',
];

const results = [];
let pass = 0, fail = 0;
for (const p of W11_PROBES) {
  const r = spawnSync('bun', [p], { encoding: 'utf8', cwd: REPO, timeout: 60_000 });
  const ok = r.status === 0;
  results.push({ probe: p, ok, status: r.status, stderr: r.stderr });
  ok ? pass++ : fail++;
}

console.log('==== W11 detect probes (run via X.5-drizzle regression shim) ====');
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.probe}` + (r.ok ? '' : `  exit=${r.status}`));
  if (!r.ok && r.stderr) console.log(`    STDERR: ${r.stderr.slice(0, 400)}`);
}
console.log(`\nTotal: ${pass} pass / ${fail} fail (out of ${results.length})`);
process.exit(fail === 0 ? 0 : 1);
