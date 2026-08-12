#!/usr/bin/env node
/**
 * bundle-agent-chat.mjs — build the agent-chat island.
 *
 * Bundles frontend/agent-chat/index.tsx (Preact + marked + DOMPurify +
 * highlight.js) into a self-contained ES module + stylesheet under
 * public/_assets/agent-chat/, served by the ASSETS binding and
 * dynamic-imported by public/s/index.html. The dependencies are build-time
 * only (worker devDependencies); nothing here enters the worker bundle.
 *
 * Output (committed, like the sibling _assets bundles):
 *   public/_assets/agent-chat/agent-chat.js
 *   public/_assets/agent-chat/agent-chat.css
 *
 * No sourcemaps. Every embedder points `assets.directory` at this package's
 * `public/` wholesale, so anything staged here is uploaded to every consumer's
 * Worker — and the two maps this used to emit were 901 KB of it, with nothing
 * reading them outside a browser devtools session. Emitting them and then
 * excluding them from the tarball would be worse than either end of the
 * choice: `sourcemap: 'linked'` writes a `sourceMappingURL` comment, so the
 * shipped bundle would point at a file that is deliberately not shipped.
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const result = await build({
  entryPoints: [path.join(ROOT, 'frontend', 'agent-chat', 'index.tsx')],
  outdir: path.join(ROOT, 'public', '_assets', 'agent-chat'),
  entryNames: 'agent-chat',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  legalComments: 'none',
  metafile: true,
});

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.map')) continue;
  console.log(`[bundle-agent-chat] ${file} ${(output.bytes / 1024).toFixed(1)} KiB`);
}
