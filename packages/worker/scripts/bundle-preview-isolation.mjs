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

const result = await build({
  entryPoints: [path.join(ROOT, 'frontend', 'preview-isolation', 'index.ts')],
  outdir: path.join(ROOT, 'public', '_assets', 'preview-isolation'),
  entryNames: 'preview-isolation',
  bundle: true,
  format: 'esm',
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
