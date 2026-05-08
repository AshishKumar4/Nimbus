#!/usr/bin/env bun
// X.5-drizzle investigation 01:
//
// Goal: prove the trigger that makes `npm install drizzle-orm` produce
// "[npm] Framework detected — installing framework-required packages (vite, …)"
// in the verify-9d4b61d drizzle-orm probe.
//
// Hypothesis (per VERIFY-9D4B61D §3 + §4 #1):
//   - Probe runs `cd app && npm install drizzle-orm` against the seeded starter.
//   - The starter's `app/package.json` (src/seed-project.ts) declares
//     `vite: ^5.4.0` in devDependencies (NO framework dep — no next/astro/
//     nuxt/remix/sveltekit, no wrangler config).
//   - `framework-detect.ts` step 8 ("`vite` in deps → 'vite'") fires with
//     confidence 0.7.
//   - `npm-installer.ts:detectFrameworkAware` returns `result.framework !== 'unknown'`
//     === true.
//   - resolver runs with frameworkAware=true → vite is exempted from
//     SKIP_PACKAGES at transitive depth → vite gets pulled into drizzle-orm's
//     install graph (via some transitive peer/optional path) → vite's
//     transitive deps include `lightningcss` → X.5-26b's
//     transitive='fail' REJECT_INSTALL fires → install is loud-rejected.
//
// This investigation probe reproduces the detector's verdict ON THE
// STARTER'S OWN package.json (no live wrangler needed) to confirm the
// trigger condition.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

// Load detector + the starter PACKAGE_JSON directly from src.
const { detectFramework } = await import(path.join(REPO, 'src', 'runtime', 'framework-detect.ts'));
const seedProject = await import(path.join(REPO, 'src', 'vfs', 'seed-project.ts'));

// seed-project.ts exposes its starter pkg.json source-of-truth via the
// PACKAGE_JSON constant — but it's NOT exported. Re-derive by reading the
// source text. (Pure-data; doesn't require running the seeder.)
import fs from 'node:fs';
const seedSrc = fs.readFileSync(path.join(REPO, 'src', 'vfs', 'seed-project.ts'), 'utf8');
const m = seedSrc.match(/const PACKAGE_JSON = `(\{[\s\S]*?\})\s*\n`;/);
if (!m) {
  console.error('FAIL: could not extract PACKAGE_JSON literal from seed-project.ts');
  process.exit(2);
}
const starterPkg = JSON.parse(m[1]);

console.log('==== Starter app/package.json (from seed-project.ts) ====');
console.log(JSON.stringify(starterPkg, null, 2));

// Mirror what npm-installer.ts:detectFrameworkAware passes to detectFramework.
const files = new Set(['package.json', 'index.html', 'vite.config.ts', 'tsconfig.json']);
const fileContents = {}; // detector doesn't read vite.config for this case

const result = detectFramework({
  pkg: {
    dependencies: starterPkg.dependencies,
    devDependencies: starterPkg.devDependencies,
    scripts: starterPkg.scripts,
  },
  files,
  fileContents,
});

console.log('==== detectFramework() verdict ====');
console.log(JSON.stringify(result, null, 2));

console.log('==== detectFrameworkAware() decision (current behavior) ====');
const isAware = result.framework !== 'unknown';
console.log('frameworkAware =', isAware, '  (returns true for ANY non-unknown framework, including generic vite)');

console.log();
console.log('==== Diagnosis ====');
if (result.framework === 'vite') {
  console.log('CONFIRMED: starter app triggers framework=vite (step 8, generic).');
  console.log('  This is what causes [npm install drizzle-orm] to run with frameworkAware=true.');
  console.log('  In that mode, transitive vite is exempted from SKIP_PACKAGES and gets pulled');
  console.log('  into the resolution → vite\\u2019s transitive lightningcss hits X.5-26b REJECT_INSTALL.');
  console.log('  Refinement target: detectFrameworkAware should NOT treat generic-vite as framework-aware,');
  console.log('  because no framework CLI is in play here — bundled real-vite handles `npm run dev`.');
  process.exit(0);
} else {
  console.log('UNEXPECTED: detectFramework on starter pkg returned', result.framework);
  console.log('Hypothesis falsified; need to investigate elsewhere.');
  process.exit(1);
}
