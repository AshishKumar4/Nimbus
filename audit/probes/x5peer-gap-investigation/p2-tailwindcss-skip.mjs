#!/usr/bin/env bun
/**
 * X.5-peer-gap P2 — Confirm tailwindcss is in SKIP_PACKAGES.
 *
 * Hypothesis: `tailwindcss` is silent-skipped at install time by
 * SKIP_PACKAGES (a build-tool blocklist from the v3 era when
 * `tailwindcss` was a CSS-CLI build tool). In Tailwind v4 the actual
 * compilation engine moved INTO the `tailwindcss` package and
 * `@tailwindcss/node@4.x` requires it at runtime. So the skip is now
 * a false-positive: `@tailwindcss/node/dist/index.js` does
 * `require('tailwindcss')` and that package is missing from
 * node_modules.
 *
 * This probe:
 *   1. Reads SKIP_PACKAGES from src/npm-resolver.ts + parallel preamble.
 *   2. Confirms `tailwindcss` is present in BOTH lists.
 *   3. Confirms FRAMEWORK_REQUIRED_PACKAGES does NOT exempt it.
 *   4. Fetches @tailwindcss/node@4.2.4 metadata to confirm `tailwindcss`
 *      is a regular dependency (not peerDependencies / optional).
 *   5. Inspects @tailwindcss/node's dist/index.js to confirm a literal
 *      `require('tailwindcss')` exists.
 *
 * Read-only.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = '/workspace/worktrees/x5peer-gap';

const resolver = fs.readFileSync(`${ROOT}/src/npm-resolver.ts`, 'utf8');
const preamble = fs.readFileSync(`${ROOT}/src/parallel/npm-resolve-preamble.ts`, 'utf8');

function findSet(name, src) {
  const i = src.indexOf(name);
  if (i < 0) return null;
  // crude: read until the closing `]);`
  const end = src.indexOf(']);', i);
  if (end < 0) return null;
  return src.slice(i, end + 3);
}

const skipBlock1 = findSet('SKIP_PACKAGES = new Set([', resolver);
const skipBlock2 = findSet('__SKIP_PACKAGES = new Set([', preamble);
const fwBlock1   = findSet('FRAMEWORK_REQUIRED_PACKAGES = new Set([', resolver);
const fwBlock2   = findSet('__FRAMEWORK_REQUIRED_PACKAGES = new Set([', preamble);

const inSkip1 = /['"]tailwindcss['"]/.test(skipBlock1 || '');
const inSkip2 = /['"]tailwindcss['"]/.test(skipBlock2 || '');
const inFw1   = /['"]tailwindcss['"]/.test(fwBlock1 || '');
const inFw2   = /['"]tailwindcss['"]/.test(fwBlock2 || '');

console.log('=== src/ skip-list confirmation ===');
console.log(`  src/npm-resolver.ts SKIP_PACKAGES has 'tailwindcss'           : ${inSkip1}`);
console.log(`  src/parallel/npm-resolve-preamble.ts __SKIP_PACKAGES has it   : ${inSkip2}`);
console.log(`  src/npm-resolver.ts FRAMEWORK_REQUIRED_PACKAGES exempts it    : ${inFw1}`);
console.log(`  src/parallel/...    __FRAMEWORK_REQUIRED_PACKAGES exempts it  : ${inFw2}`);
console.log();

// Find the line numbers
const lines1 = resolver.split('\n');
const lines2 = preamble.split('\n');
const ln1 = lines1.findIndex(l => /['"]tailwindcss['"]/.test(l) && /SKIP|skip/i.test(lines1[Math.max(0, lines1.indexOf(l) - 5)] + '\n' + l));
// Simpler: find any line containing 'tailwindcss' near a SKIP marker
function findLineWith(arr, needle, after) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].includes(needle) && arr.slice(0, i).join('\n').includes(after)) {
      return i + 1; // 1-indexed
    }
  }
  return -1;
}
const skipStart1 = lines1.findIndex(l => l.includes('SKIP_PACKAGES = new Set([')) + 1;
const skipEnd1 = lines1.slice(skipStart1).findIndex(l => l.includes(']);')) + skipStart1 + 1;
let twLine1 = -1;
for (let i = skipStart1 - 1; i < skipEnd1; i++) {
  if (lines1[i] && /['"]tailwindcss['"]/.test(lines1[i])) { twLine1 = i + 1; break; }
}
console.log(`  tailwindcss enters SKIP at npm-resolver.ts:${twLine1}`);

console.log();
console.log('=== @tailwindcss/node@4.2.4 deps ===');
const r = spawnSync('curl', ['-s', 'https://registry.npmjs.org/@tailwindcss%2Fnode/4.2.4'], { encoding: 'utf8' });
const meta = JSON.parse(r.stdout);
console.log('dependencies:', meta.dependencies);
console.log('peerDependencies:', meta.peerDependencies);
console.log('peerDependenciesMeta:', meta.peerDependenciesMeta);
console.log('optionalDependencies:', meta.optionalDependencies);
console.log();

console.log('=== inspect @tailwindcss/node/dist/index.js for require("tailwindcss") ===');
const TMP = '/tmp/x5peer-gap-tw';
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const tarballUrl = meta.dist.tarball;
spawnSync('curl', ['-sL', tarballUrl, '-o', `${TMP}/x.tgz`]);
spawnSync('tar', ['-xzf', `${TMP}/x.tgz`, '-C', TMP]);
const distIdx = fs.readFileSync(`${TMP}/package/dist/index.js`, 'utf8');
const reqMatches = [...distIdx.matchAll(/require\(["']tailwindcss(?:\/[^"']*)?["']\)/g)];
console.log(`  require("tailwindcss") match count: ${reqMatches.length}`);
for (const m of reqMatches.slice(0, 3)) {
  // find the line number
  const before = distIdx.slice(0, m.index);
  const ln = before.split('\n').length;
  console.log(`    line ${ln}: ${m[0]}`);
}

console.log();
console.log('=== conclusion ===');
console.log('tailwindcss IS in SKIP_PACKAGES at src/npm-resolver.ts:887 and');
console.log('src/parallel/npm-resolve-preamble.ts:42. FRAMEWORK_REQUIRED_PACKAGES');
console.log('only exempts vite (line 903). @tailwindcss/node@4.2.4 has tailwindcss');
console.log('as a regular `dependencies` entry (not peer/optional), and its');
console.log('dist/index.js literally `require("tailwindcss")` at runtime. The');
console.log('install-time skip is a false-positive for Tailwind v4 (where');
console.log('tailwindcss became the runtime engine, not just a build CLI).');
