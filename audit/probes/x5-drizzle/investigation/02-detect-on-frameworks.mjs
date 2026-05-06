#!/usr/bin/env bun
// X.5-drizzle investigation 02:
//
// Confirm that the 5 real frameworks (next/astro/nuxt/remix/sveltekit)
// + wrangler-on-framework still return their respective framework IDs
// (NOT 'vite' and NOT 'unknown'). These are the cases where
// frameworkAware MUST stay true after our refinement.
//
// We mirror the W11 functional fixtures.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const { detectFramework } = await import(path.join(REPO, 'src', 'framework-detect.ts'));

const cases = [
  {
    label: 'next.js project',
    input: {
      pkg: { dependencies: { next: '14.2.0', react: '18.3.1' }, devDependencies: {}, scripts: { dev: 'next dev' } },
      files: new Set(['package.json', 'next.config.js']),
    },
    expectedFramework: 'next',
    expectedAware: true,
  },
  {
    label: 'astro project',
    input: {
      pkg: { dependencies: { astro: '4.0.0' }, devDependencies: {}, scripts: { dev: 'astro dev' } },
      files: new Set(['package.json', 'astro.config.mjs']),
    },
    expectedFramework: 'astro',
    expectedAware: true,
  },
  {
    label: 'nuxt project',
    input: {
      pkg: { dependencies: { nuxt: '3.10.0' }, devDependencies: {}, scripts: { dev: 'nuxi dev' } },
      files: new Set(['package.json', 'nuxt.config.ts']),
    },
    expectedFramework: 'nuxt',
    expectedAware: true,
  },
  {
    label: 'remix v2 project',
    input: {
      pkg: { dependencies: { '@remix-run/dev': '2.5.0', '@remix-run/react': '2.5.0', vite: '5.4.0' }, devDependencies: {}, scripts: { dev: 'remix vite:dev' } },
      files: new Set(['package.json', 'vite.config.ts']),
      fileContents: { 'vite.config.ts': "import { vitePlugin as remix } from '@remix-run/dev';\nexport default {};" },
    },
    expectedFramework: 'remix',
    expectedAware: true,
  },
  {
    label: 'sveltekit project',
    input: {
      pkg: { dependencies: { '@sveltejs/kit': '2.0.0', vite: '5.4.0' }, devDependencies: {}, scripts: { dev: 'vite dev' } },
      files: new Set(['package.json', 'svelte.config.js']),
    },
    expectedFramework: 'sveltekit',
    expectedAware: true,
  },
  {
    label: 'wrangler-on-framework (svelte+wrangler)',
    input: {
      pkg: { dependencies: { '@sveltejs/kit': '2.0.0', wrangler: '3.0.0' }, devDependencies: {}, scripts: {} },
      files: new Set(['package.json', 'wrangler.jsonc', 'svelte.config.js']),
    },
    expectedFramework: 'sveltekit',
    expectedAware: true,
  },
  {
    label: 'wrangler standalone (no framework)',
    input: {
      pkg: { dependencies: { wrangler: '3.0.0' }, devDependencies: {}, scripts: {} },
      files: new Set(['package.json', 'wrangler.jsonc']),
    },
    expectedFramework: 'wrangler',
    expectedAware: true, // wrangler IS its own framework — keep aware true (W10 territory)
  },
  {
    label: 'STARTER (generic vite + react, no framework)',
    input: {
      pkg: {
        dependencies: { react: '18.3.1', 'react-dom': '18.3.1', 'react-router-dom': '6.26.0' },
        devDependencies: { vite: '5.4.0' },
        scripts: { dev: 'vite' },
      },
      files: new Set(['package.json', 'vite.config.ts']),
    },
    expectedFramework: 'vite',
    expectedAware: false, // <-- THIS IS THE FIX TARGET
  },
  {
    label: 'pure node lib (no framework, no vite)',
    input: {
      pkg: { dependencies: {}, devDependencies: {}, scripts: {} },
      files: new Set(['package.json']),
    },
    expectedFramework: 'unknown',
    expectedAware: false,
  },
];

let pass = 0, fail = 0;
console.log('==== Per-case detector verdict + post-fix frameworkAware semantics ====');
for (const c of cases) {
  const r = detectFramework(c.input);
  // Post-fix semantics: frameworkAware = true unless framework is 'vite' or 'unknown'.
  const postFixAware = r.framework !== 'unknown' && r.framework !== 'vite';
  const ok = r.framework === c.expectedFramework && postFixAware === c.expectedAware;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag} ${c.label}`);
  console.log(`     framework=${r.framework} (expected ${c.expectedFramework})`);
  console.log(`     aware(post-fix)=${postFixAware} (expected ${c.expectedAware})`);
  if (!ok) fail++; else pass++;
}
console.log();
console.log(`Summary: ${pass} pass / ${fail} fail (out of ${cases.length})`);
process.exit(fail === 0 ? 0 : 1);
