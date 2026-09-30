#!/usr/bin/env node
/**
 * bundle-preview-isolation.mjs — ship the preview-isolation rules to the shell.
 *
 * `src/_shared/preview-isolation.ts` is one module with two readers: the
 * router, which serves the isolated shell, and the shell page, which decides
 * what the preview pane offers. The router imports it from dist; this bundles
 * the same source into an ES module under public/_assets/preview-isolation/,
 * served by the ASSETS binding and dynamic-imported by public/s/index.html,
 * so the query name and the rules cannot drift between the two.
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
  entryPoints: [path.join(ROOT, 'src', '_shared', 'preview-isolation.ts')],
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
