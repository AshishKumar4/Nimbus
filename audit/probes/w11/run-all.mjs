#!/usr/bin/env bun
// W11 probe orchestrator — runs functional → regression → e2e in order.
// e2e self-skips when NIMBUS_W11_E2E unset (mirrors W5/W9 convention).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FUNCTIONAL = [
  'detect-next.mjs',
  'detect-astro.mjs',
  'detect-nuxt.mjs',
  'detect-remix.mjs',
  'detect-remix-bare-react.mjs',
  'detect-sveltekit.mjs',
  'detect-vite-generic.mjs',
  'detect-wrangler.mjs',
  'detect-wrangler-on-framework.mjs',
  'detect-unknown.mjs',
  'detect-precedence.mjs',
  'shim-modules-loadable.mjs',
  'vite-import-resolves-from-fixture.mjs',
];

const REGRESSION = [
  'install-pipeline-coverage.mjs',
  'seed-project-shape.mjs',
  'bundler-bin-prefixes-include-frameworks.mjs',
  'cp-facet-direct-includes-frameworks.mjs',
  'w3-w9-probe-presence.mjs',
];

const E2E = [
  'sveltekit-dev-200.mjs',
  'sveltekit-build-emits.mjs',
  'astro-dev-200.mjs',
  'astro-build-emits.mjs',
  'remix-dev-200.mjs',
  'remix-build-emits.mjs',
  'nuxt-dev-200.mjs',
  'next-dev-200.mjs',
];

const SUITE = [
  ...FUNCTIONAL.map(f => ['functional', f]),
  ...REGRESSION.map(f => ['regression', f]),
  ...E2E.map(f => ['e2e', f]),
];

const results = [];
let allOk = true;

for (const [bucket, file] of SUITE) {
  const probe = path.join(HERE, bucket, file);
  console.log(`\n========================================`);
  console.log(`# Running ${bucket}/${file}`);
  console.log(`========================================`);
  const t0 = Date.now();
  const r = spawnSync('bun', [probe], {
    stdio: 'inherit',
    cwd: path.resolve(HERE, '..', '..', '..'),
  });
  const ms = Date.now() - t0;
  const ok = r.status === 0;
  results.push({ bucket, file, ok, ms, code: r.status });
  if (!ok) allOk = false;
}

console.log(`\n========================================`);
console.log(`# W11 probe summary`);
console.log(`========================================`);
const lines = [];
for (const r of results) {
  const flag = r.ok ? '✓' : '✗';
  const line = `${flag} ${r.bucket}/${r.file} (${r.ms}ms, exit=${r.code})`;
  console.log(line);
  lines.push(line);
}
console.log(allOk ? '\n# ALL GREEN' : '\n# FAILED');

const target = path.join(HERE, allOk ? 'results-build.txt' : 'results-pending.txt');
fs.writeFileSync(
  target,
  '# W11 probe run @ ' + new Date().toISOString() + '\n' + lines.join('\n') + '\n' +
  (allOk ? '# all green\n' : '# not all green\n'),
);

process.exit(allOk ? 0 : 1);
