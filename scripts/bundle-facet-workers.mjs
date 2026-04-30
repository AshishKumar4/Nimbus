#!/usr/bin/env node
/**
 * bundle-facet-workers.mjs — Produce the preamble string that
 * NimbusFacetPool injects into dynamic workers.
 *
 * WHY this exists:
 *   NimbusFacetPool's user functions get wrapped by cloudflare-parallel's
 *   codegen into a module source. Inside that module the user function
 *   can reference closure-variables only through the `context` option,
 *   which is JSON-only — you cannot pass a helper function through it.
 *
 *   For the npm install facet we need the streaming tar parser
 *   (src/npm-tarball-stream.ts) available as a top-level named export
 *   the user function can call. We esbuild-bundle that source file into
 *   a self-contained ES module string, and NimbusFacetPool's `preamble`
 *   option splices it into the generated module between the
 *   WorkerEntrypoint import and the user function.
 *
 * Output:
 *   src/parallel/generated-workers.ts — exports
 *       TAR_STREAM_PREAMBLE: string
 *       TAR_STREAM_PREAMBLE_SIZE: number
 *
 * Runs as a postinstall + predev + predeploy step via package.json.
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

async function main() {
  // Bundle the tar parser as a single ESM module. It's dependency-free by
  // construction (src/npm-tarball-stream.ts imports nothing), so the bundle
  // is essentially a transpiled copy — we still run it through esbuild to
  // strip TypeScript types and get a verifiable one-line-per-function output.
  const result = await build({
    entryPoints: [join(root, 'src', 'npm-tarball-stream.ts')],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    write: false,
    logLevel: 'warning',
    // Strip license banner; keep things deterministic for size reporting.
    legalComments: 'none',
    // No externals — this file has no imports.
  });

  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('esbuild produced no output');
  }
  const code = result.outputFiles[0].text;

  // Preamble emission: the bundled ESM declares `export` on each function
  // and emits an aggregate `export { ... };` block at the end. Inside a
  // module that embeds this text, BOTH are invalid (the enclosing module
  // can't re-export from an inlined blob). Strip both forms:
  //   - leading `export ` on declarations (function / async function / const)
  //   - the trailing `export { name1, name2, ... };` aggregate block
  let stripped = code.replace(/^export\s+(async\s+function|function|const)\b/gm, '$1');
  stripped = stripped.replace(/\n?export\s*\{[^}]*\}\s*;\s*$/g, '');

  const encoded = JSON.stringify(stripped);
  const outPath = join(root, 'src', 'parallel', 'generated-workers.ts');

  const tsWrapper = [
    '/**',
    ' * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/npm-tarball-stream.ts (streaming tar primitives)',
    ' *',
    ' * Consumed by src/parallel/facet-pool.ts callers via the `preamble`',
    ' * option. The preamble is injected at the top of every generated',
    ' * worker module so user functions can reference the exported',
    ' * helpers (parseTarHeader, streamTarEntries, readableStreamToAsyncIterable,',
    ' * MAX_FILE_BYTES) by name.',
    ' *',
    ` * Generated at: ${new Date().toISOString()}`,
    ` * Size: ${(stripped.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const TAR_STREAM_PREAMBLE: string = ${encoded};`,
    '',
    `export const TAR_STREAM_PREAMBLE_SIZE: number = ${stripped.length};`,
    '',
  ].join('\n');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, tsWrapper);

  console.log(
    `[bundle-facet-workers] wrote ${outPath} (${(stripped.length / 1024).toFixed(2)} KiB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-facet-workers] FAILED:', e?.message || e);
  process.exitCode = 1;
});
