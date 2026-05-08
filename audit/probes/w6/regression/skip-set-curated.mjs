// W6 regression: post-W6 SKIP_PACKAGES set is exactly the curated
// residual list. Catches accidental re-adds (esbuild/fsevents back
// into skip → masks registry) AND accidental removals (a real
// build-only tool slips through and gets installed).
//
// Plan §4.0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER = path.resolve(HERE, '../../../../src/npm/resolver.ts');
const PREAMBLE = path.resolve(HERE, '../../../../src/parallel/npm-resolve-preamble.ts');

// The curated post-W6 set. Anything NOT in here must NOT be in SKIP_PACKAGES.
// Anything in here must remain in SKIP_PACKAGES.
const POST_W6_SKIP = new Set([
  // Build tools (X.5-G: rollup migrated to WASM_SWAPS)
  'typescript', 'vite', 'webpack', 'parcel',
  'postcss', 'autoprefixer', 'tailwindcss', 'cssnano',
  'prettier', 'eslint', 'stylelint',
  // Native dev-only / build (chokidar = real-vite intercepts; node-gyp/pre-gyp = build-time)
  'chokidar', 'node-gyp', 'node-pre-gyp',
  // Cloudflare dev tools
  '@cloudflare/vite-plugin', '@cloudflare/workers-types', 'wrangler',
  // Lifecycle hooks
  'husky', 'lint-staged', 'commitlint',
  // NOTE: 'esbuild' moved to WASM_SWAPS (W6)
  // NOTE: 'fsevents' moved to REJECT_INSTALL (W6, transitive=warn)
  // NOTE: 'rollup'   moved to WASM_SWAPS (X.5-G; → @rollup/wasm-node)
]);

const REMOVED_FROM_SKIP = ['esbuild', 'fsevents', 'rollup'];

function extractSkipSet(src) {
  // Find `const SKIP_PACKAGES = new Set([...])` block; pull all quoted strings.
  const m = src.match(/SKIP_PACKAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  const body = m[1];
  const out = new Set();
  for (const sm of body.matchAll(/['"`]([^'"`]+)['"`]/g)) {
    out.add(sm[1]);
  }
  return out;
}

let resolverSrc, preambleSrc;
try {
  resolverSrc = fs.readFileSync(RESOLVER, 'utf8');
  preambleSrc = fs.readFileSync(PREAMBLE, 'utf8');
} catch (e) {
  ok('source files readable', false, e.message);
  summary('w6/regression/skip-set-curated');
}

const resolverSkip = extractSkipSet(resolverSrc);
// Preamble uses a different identifier — try both naming conventions.
let preambleSkip = extractSkipSet(preambleSrc);
if (!preambleSkip) {
  // Try __SKIP_PACKAGES specifically
  const m = preambleSrc.match(/__SKIP_PACKAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (m) {
    preambleSkip = new Set();
    for (const sm of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) preambleSkip.add(sm[1]);
  }
}

group('npm-resolver.ts SKIP_PACKAGES is the curated set', () => {
  ok('SKIP_PACKAGES extracted', !!resolverSkip);
  if (resolverSkip) {
    for (const name of POST_W6_SKIP) {
      ok(`includes ${name}`, resolverSkip.has(name));
    }
    for (const name of REMOVED_FROM_SKIP) {
      ok(`excludes (moved out) ${name}`, !resolverSkip.has(name));
    }
    // Also check size — guards against silent additions
    eq('SKIP_PACKAGES.size matches curated', resolverSkip.size, POST_W6_SKIP.size);
  }
});

group('npm-resolve-preamble.ts SKIP set mirrors resolver', () => {
  ok('preamble SKIP extracted', !!preambleSkip);
  if (preambleSkip && resolverSkip) {
    eq('same size', preambleSkip.size, resolverSkip.size);
    for (const name of resolverSkip) {
      ok(`preamble has ${name}`, preambleSkip.has(name));
    }
  }
});

summary('w6/regression/skip-set-curated');
