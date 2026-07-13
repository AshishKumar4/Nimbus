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
 *   public/_assets/agent-chat/agent-chat.js  (+ .js.map)
 *   public/_assets/agent-chat/agent-chat.css (+ .css.map)
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
  sourcemap: 'linked',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  legalComments: 'none',
  metafile: true,
});

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.map')) continue;
  console.log(`[bundle-agent-chat] ${file} ${(output.bytes / 1024).toFixed(1)} KiB`);
}
