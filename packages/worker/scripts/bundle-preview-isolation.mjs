#!/usr/bin/env node
/**
 * bundle-preview-isolation.mjs — build the shell's isolation offer.
 *
 * Bundles frontend/preview-isolation/index.ts (the offer strip's controller)
 * with the rules it shares with the router (src/_shared/preview-isolation.ts)
 * into an ES module under public/_assets/preview-isolation/, served by the
 * ASSETS binding and dynamic-imported by public/s/index.html, so the query
 * name and the rules cannot drift between the router and the page.
 *
 * Output (committed, like the sibling _assets bundles):
 *   public/_assets/preview-isolation/preview-isolation.js
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{ entry: string; name: string; format: import('esbuild').Format; globalName?: string }>} */
const bundles = [
  { entry: path.join(ROOT, 'frontend', 'preview-isolation', 'index.ts'), name: 'preview-isolation', format: 'esm' },
  { entry: path.resolve(ROOT, '..', 'core', 'src', '_shared', 'id-component.ts'), name: 'session-id', format: 'iife', globalName: 'NimbusSessionId' },
];
for (const { entry, name, format, globalName } of bundles) {
  const result = await build({
    entryPoints: [entry],
    outdir: path.join(ROOT, 'public', '_assets', name),
    entryNames: name,
    bundle: true,
    format,
    globalName,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
  });

  for (const [file, output] of Object.entries(result.metafile.outputs)) {
    console.log(`[bundle-preview-isolation] ${file} ${(output.bytes / 1024).toFixed(1)} KiB`);
  }
}
