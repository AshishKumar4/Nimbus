#!/usr/bin/env bun
// X.5-drizzle functional — preserves the W11 framework-detect contract.
//
// X.5-drizzle's actual fix lives in src/npm-resolver.ts +
// src/npm-resolve-facet.ts (best-effort optional-peer soft-skip),
// NOT in the framework-detect heuristic. This probe verifies that the
// detector verdicts for the 5 W11 frameworks + wrangler-on-fw +
// wrangler-standalone are unchanged — preventing accidental regression
// of the W11 detector contract.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const { detectFramework } = await import(path.join(REPO, 'src', 'runtime', 'framework-detect.ts'));

const cases = [
  { label: 'next.js', pkg: { dependencies: { next: '14.2.0', react: '18.3.1' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'next.config.js'], expectFw: 'next' },
  { label: 'astro',   pkg: { dependencies: { astro: '4.0.0' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'astro.config.mjs'], expectFw: 'astro' },
  { label: 'nuxt',    pkg: { dependencies: { nuxt: '3.10.0' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'nuxt.config.ts'], expectFw: 'nuxt' },
  {
    label: 'remix v2',
    pkg: { dependencies: { '@remix-run/dev': '2.5.0', '@remix-run/react': '2.5.0', vite: '5.4.0' }, devDependencies: {}, scripts: {} },
    files: ['package.json', 'vite.config.ts'],
    fileContents: { 'vite.config.ts': "import { vitePlugin as remix } from '@remix-run/dev';\nexport default {};" },
    expectFw: 'remix',
  },
  { label: 'sveltekit', pkg: { dependencies: { '@sveltejs/kit': '2.0.0', vite: '5.4.0' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'svelte.config.js'], expectFw: 'sveltekit' },
  { label: 'wrangler-on-fw (sk+wrangler)', pkg: { dependencies: { '@sveltejs/kit': '2.0.0', wrangler: '3.0.0' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'wrangler.jsonc', 'svelte.config.js'], expectFw: 'sveltekit' },
  { label: 'wrangler-standalone', pkg: { dependencies: { wrangler: '3.0.0' }, devDependencies: {}, scripts: {} }, files: ['package.json', 'wrangler.jsonc'], expectFw: 'wrangler' },
  { label: 'generic vite (starter / Mossaic)', pkg: { dependencies: { react: '18.3.1' }, devDependencies: { vite: '5.4.0' }, scripts: {} }, files: ['package.json', 'vite.config.ts'], expectFw: 'vite' },
  { label: 'pure-node-lib', pkg: { dependencies: {}, devDependencies: {}, scripts: {} }, files: ['package.json'], expectFw: 'unknown' },
];

for (const c of cases) {
  await group(`detector contract: ${c.label}`, () => {
    const r = detectFramework({
      pkg: c.pkg,
      files: new Set(c.files),
      fileContents: c.fileContents,
    });
    eq(`  framework=${c.expectFw}`, r.framework, c.expectFw);
  });
}

await summary('x5-drizzle/functional/detect-aware-preserves-frameworks');
